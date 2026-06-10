---
name: aws-api-codegen-fixer
description: "Apply approved API test-code fixes from healing/fix-proposal.json. Modifies only generated API test files allowed by the proposal."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.healing.status == proposal_created`.
3. Read `qa/changes/<change-id>/healing/fix-proposal.json` — stop if missing.
4. Read `qa/changes/<change-id>/inspect/failure-analysis.json`.
5. Read `qa/changes/<change-id>/codegen/api-codegen-summary.md` to confirm which files were generated.
6. Do **not** apply patches not listed in `fix-proposal.json`.

**After completing work:**

1. Verify `healing/api-apply-summary.json` exists and is valid JSON.
2. Verify `healing/api-apply-summary.md` exists.
3. Verify every modified file is in the allowed list.
4. Update `workflow-state.yaml`: `phases.healing.status = applied`.

---

# Skill: aws-api-codegen-fixer

## Purpose

`aws-api-codegen-fixer` is **Phase 11A** of the healing loop.

It reads `healing/fix-proposal.json`, filters to proposals with `target == "api"` and `eligible == true`, and applies the approved patches to generated API test files.

## Role Boundary

This skill:

- **May** modify files listed in the allowed file set (see below)
- **May** only apply operations described in `fix-proposal.json.proposals[].patch_plan`
- **Must NOT** modify product code (`app/`, `web/`, `src/`)
- **Must NOT** change assertion expected values
- **Must NOT** skip or delete failing tests
- **Must NOT** modify E2E test files
- **Must NOT** modify unrelated test files outside the change scope

---

## Allowed Files

A file is eligible for modification only if **all** of the following are true:

1. It matches one of these patterns:
   ```text
   tests/api/test_<module>_api.py
   tests/api/helpers/<module>_api.py
   tests/api/conftest.py
   tests/fixtures/**/*.py
   ```

2. It appears in **at least one** of:
   - `phases.api_codegen.generated_tests.files` in `workflow-state.yaml`
   - `proposals[].files_to_modify` in `fix-proposal.json`
   - `codegen/api-codegen-summary.md` generated/reused files section

If a proposal targets a file not satisfying both conditions → **STOP**, write `healing/api-fixer-error.json`, do not apply.

---

## Forbidden Files

Absolutely forbidden — never modify:

```text
app/**
web/**
src/**
qa/changes/<change-id>/cases/**
qa/changes/<change-id>/plans/**
qa/changes/<change-id>/review/**
.aws/config.yaml
.aws/data-knowledge.yaml
tests/e2e/**
```

If a proposal in `fix-proposal.json` requires modifying any forbidden file:

1. **STOP** immediately.
2. Write `qa/changes/<change-id>/healing/api-fixer-error.json`.
3. Do **not** apply any patch.
4. Do **not** rerun.
5. Update `workflow-state.yaml`: `phases.healing.status = failed`.

---

## Forbidden Operations

Never perform:

- Modify product code
- Change assertion expected values (e.g., changing `assert response.status_code == 201` to `assert response.status_code == 200`)
- Delete failing test functions
- Add `pytest.mark.skip`
- Add `pytest.mark.xfail`
- Add `@pytest.mark.skip`
- Lower assertion strength (e.g., `assert len(items) > 0` → `assert items is not None`)
- Mark known product issues as passing
- Weaken HTTP status code assertions

---

## Allowed Operations

Permitted repairs:

- Correct wrong helper function call signatures
- Fix test data generation (incorrect field names, missing required fields, wrong data types)
- Fix fixture name conflicts
- Correct `httpx` client parameter usage
- Add missing but schema-required request fields
- Fix request payload structure to match API schema
- Fix API helper return value parsing
- Fix cleanup fixture ordering
- Correct import paths

---

## Application Process

For each proposal in `fix-proposal.json` where `target == "api"` and `eligible == true`:

1. Read the current content of each file in `files_to_modify`.
2. Validate the file is in the allowed set (see **Allowed Files**).
3. Apply each `patch_plan` step sequentially:
   - `replace`: replace identified code pattern with corrected version
   - `insert`: add new code at specified location
   - `refactor`: restructure existing code without changing behavior
   - `add_helper`: add a new helper function
4. After each file modification, re-read the file to verify the patch applied correctly.
5. Record the modification in `healing/api-apply-summary.json`.

---

## Output Files

Write after all eligible proposals are processed:

**`qa/changes/<change-id>/healing/api-apply-summary.json`:**

```json
{
  "schema_version": "1.0",
  "change_id": "<change-id>",
  "target": "api",
  "applied": true,
  "applied_proposals": [
    {
      "proposal_id": "FIX-001",
      "files_modified": ["tests/api/test_menu_api.py"],
      "operations_applied": ["fix_request_payload"],
      "notes": ""
    }
  ],
  "modified_files": ["tests/api/test_menu_api.py"],
  "skipped_proposals": [
    {
      "proposal_id": "FIX-002",
      "reason": "target is e2e, not api"
    }
  ],
  "forbidden_attempts": [],
  "rerun_required": true,
  "next_action": "run_aws_run"
}
```

**`qa/changes/<change-id>/healing/api-apply-summary.md`:**

```markdown
# API Codegen Fixer — Apply Summary

**Change**: <change-id>
**Applied at**: <timestamp>
**Proposals applied**: <N>
**Files modified**: <N>

## Applied Fixes

### FIX-001 — test_code_error (api)

**File**: `tests/api/test_menu_api.py`
**Operation**: fix_request_payload
**Description**: Added missing required `category_id` field to POST /api/v1/menu/create payload

---

## Skipped Proposals

| Proposal | Reason |
|----------|--------|
| FIX-002 | target=e2e, not handled by this fixer |

---

## Next Action

Re-run tests: `aws run --change <change-id>`
```

---

## Error Output

If a forbidden file is targeted or a forbidden operation is required, write:

**`qa/changes/<change-id>/healing/api-fixer-error.json`:**

```json
{
  "schema_version": "1.0",
  "change_id": "<change-id>",
  "target": "api",
  "error": "forbidden_file_targeted|forbidden_operation_required",
  "proposal_id": "FIX-001",
  "forbidden_file": "app/api/menu.py",
  "reason": "Proposal requires modifying product code; this is not allowed in healing loop",
  "applied": false,
  "rerun_required": false,
  "next_action": "developer_fix_required"
}
```

---

## Workflow-state Update

After successful application:

```yaml
phases:
  healing:
    status: applied
    attempts:
      - attempt: <n>
        applied_files:
          - tests/api/test_<module>_api.py
        result: rerun_required
```

After forbidden modification attempt:

```yaml
phases:
  healing:
    status: failed
    stop_reason: "forbidden file targeted or forbidden operation required"
```

---

## Steps

1. Read `workflow-state.yaml` — verify `phases.healing.status == proposal_created`.
2. Read `healing/fix-proposal.json`.
3. Filter: `target == "api"` and `eligible == true`.
4. If no API proposals: write minimal `api-apply-summary.json` with `applied: false`, update `workflow-state.yaml`.
5. For each API proposal:
   a. Validate all `files_to_modify` are in the allowed set.
   b. If any forbidden file: write `api-fixer-error.json`, STOP.
   c. Apply each `patch_plan` step.
   d. Verify patch was applied (re-read file).
6. Write `healing/api-apply-summary.json` and `healing/api-apply-summary.md`.
7. Update `workflow-state.yaml`.
8. Report summary to user.

---

## Hard Rules

- **Never** modify files outside the allowed set.
- **Never** modify `app/`, `web/`, or `src/`.
- **Never** change assertion expected values.
- **Never** add `pytest.mark.skip`, `xfail`, or equivalent.
- **Never** delete failing tests.
- **Always** verify the patch applied by re-reading the file.
- **Always** set `rerun_required: true` in `api-apply-summary.json`.
- If `phases.healing.status != proposal_created`, stop and report.

---

## Example

**API test payload missing required schema field:**

```text
Failure: test_create_menu_returns_201 — 422 Unprocessable Entity
Category: test_code_error
Analysis: POST /api/v1/menu/create payload missing required field `category_id`
```

Fix proposal says:
```json
{
  "proposal_id": "FIX-001",
  "target": "api",
  "patch_plan": [
    {
      "file": "tests/api/test_menu_api.py",
      "operation": "replace",
      "description": "Add missing category_id field in menu create payload",
      "constraints": ["must not change assertion status code check"]
    }
  ]
}
```

This skill:
1. Reads `tests/api/test_menu_api.py`
2. Validates file is in generated_tests.files
3. Locates the payload dict in `test_create_menu_returns_201`
4. Adds `"category_id": menu_category_fixture["id"]` to the payload
5. Re-reads the file to confirm change
6. Records in `api-apply-summary.json`
