---
name: qa-archive
description: Use after qa-review passes. Merges case-delta into qa/cases/, confirms test code exists in tests/, archives process artifacts to qa/archive/<change-id>/. Requires no BLOCKs in any review file.
---

## Purpose

Complete the change cycle: merge primary assets and archive process artifacts.

## When to Use

- After `qa-review` produces no BLOCKs
- User says "archive change <change-id>"
- User says "merge and close this change"

## Pre-condition

ALL of these must be true:
- `case.review.yaml` → `overall_status: PASS` or `WARNING` (not BLOCK)
- `code.review.yaml` → `overall_status: PASS` or `WARNING` (not BLOCK)
- `execution.review.yaml` → `overall_status: PASS` or `WARNING` (not BLOCK)

If any is BLOCK: STOP. Do not archive.

## Output

After archiving:
```
qa/cases/<module>.md          ← updated with case-delta
tests/api/**                  ← retained as-is (already primary asset)
tests/e2e/**                  ← retained as-is (already primary asset)
qa/archive/<change-id>/       ← all process artifacts
qa/archive/<change-id>/archive-summary.md
```

## Process

### Step 1: Check Review Gate
Read all three `*.review.yaml` files.
If any has `overall_status: BLOCK` → STOP immediately.

### Step 2: Merge Case Delta
For each file under `qa/changes/<change-id>/case-delta/`:
- Map to corresponding `qa/cases/<module>.md`
- Apply ADDED: append new cases
- Apply MODIFIED: find matching Case ID and replace entire block
- Apply REMOVED: find and delete matching Case ID block

After merge: verify no duplicate Case IDs, no orphaned references.

### Step 3: Confirm Test Code
Verify test files specified in subplans exist at `tests/api/` or `tests/e2e/`.
If test files are missing: STOP. Test code must exist before archiving.

### Step 4: Archive Process Artifacts

Move to `qa/archive/<change-id>/`:

| Source | Destination |
|--------|-------------|
| `qa/changes/<id>/subplans/` | `qa/archive/<id>/subplans/` |
| `qa/changes/<id>/review/` | `qa/archive/<id>/review/` |
| `qa/changes/<id>/execution/` | `qa/archive/<id>/execution/` |
| `qa/changes/<id>/trace/` | `qa/archive/<id>/trace/` |

Run: `python scripts/qa_archive.py <change-id>`

### Step 5: Write Archive Summary

Write to: `qa/archive/<change-id>/archive-summary.md`

Must include:
- cases added/modified/removed (count + IDs)
- test files created/updated
- execution summary
- review outcome

## What NEVER Gets Merged Into qa/cases/
- SubPlans (temporary execution plans)
- Review files (process artifacts)
- Execution results (historical records)

## Red Flags

| Thought | Reality |
|---------|---------|
| "I'll merge the subplan into qa/cases/" | SubPlans are NEVER merged into cases. |
| "I'll archive without checking review" | Review gate is mandatory. |
| "The test code is already there, skip step 3" | Confirm explicitly — step 3 is a safety check. |
| "I'll skip the archive summary" | Archive summary is the audit trail. |

## Post-Archive State

Change cycle is complete:
- `qa/cases/` reflects new/modified/removed cases
- `tests/` contains test code (primary assets)
- `qa/archive/<id>/` holds all process artifacts for audit
- `qa/changes/<id>/` can be safely removed
