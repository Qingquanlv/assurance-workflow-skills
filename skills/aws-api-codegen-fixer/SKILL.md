---
name: aws-api-codegen-fixer
description: "Apply approved API test-code fixes from healing/fix-proposal.json. Modifies only generated API test files allowed by the proposal."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.healing.status == proposal_created` — if not, STOP and report.
3. Read `qa/changes/<change-id>/healing/fix-proposal.json` — stop if missing.
4. Read `qa/changes/<change-id>/inspect/failure-analysis.json`.
5. Read `qa/changes/<change-id>/codegen/api-codegen-summary.md` to get the trusted set of generated/reused files.
6. Do **not** apply patches not listed in `fix-proposal.json`.

**After completing work:**

1. Verify `qa/changes/<change-id>/healing/api-apply-summary.json` exists and is valid JSON.
2. Verify `qa/changes/<change-id>/healing/api-apply-summary.md` exists.
3. Verify every modified file is in the allowed list.
4. Update **only** the per-target status field in `workflow-state.yaml`:

```yaml
phases:
  healing:
    attempts:
      - attempt: <n>
        api_apply_status: applied | no_op | failed
        api_apply_summary: qa/changes/<change-id>/healing/api-apply-summary.json
```

**Do NOT** set `phases.healing.status = applied` — this is the orchestrator's responsibility after both API and E2E fixers complete and the Fixer Safety Gate passes.

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

A file is eligible for modification only if **all three** conditions are satisfied:

**Condition 1 — Pattern match:**

```text
tests/api/test_<module>_api.py
tests/api/helpers/<module>_api.py
tests/api/conftest.py
tests/fixtures/**/*.py
```

**Condition 2 — Proposal request:** the file appears in `fix-proposal.json.proposals[].files_to_modify`.

**Condition 3 — Trusted source authorization:** the file also appears in **at least one** of:
- `phases.api_codegen.generated_tests.files` in `workflow-state.yaml`
- `codegen/api-codegen-summary.md` generated/reused/updated files section

`proposals[].files_to_modify` is a **request**, not an authorization source. A proposal may only target a file that is independently confirmed as being part of the current change's generated test set.

If a file satisfies Conditions 1 and 2 but not Condition 3 → **STOP**, write `healing/api-fixer-error.json`, do not apply any patch.

### Special rule for `tests/api/conftest.py`

`tests/api/conftest.py` is a shared fixture file affecting all API tests. It may be modified only if **all** of the following hold:

- It satisfies Conditions 1, 2, and 3 above.
- The patch is limited exclusively to fixtures or helpers introduced or used by the current change (as listed in `api-codegen-summary.md`).
- The patch does **not** rename or delete any existing public fixture.
- The patch does **not** change the behavior of fixtures used by unrelated tests.

Forbidden on `conftest.py`:
- Renaming shared fixtures
- Deleting existing fixture functions
- Changing parameters or return values of fixtures used by tests outside the current change scope

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

## Risk Gate

Only apply proposals where **all** are true:

- `eligible == true`
- `target == "api"`
- `risk_level in ["low", "medium"]`

If `risk_level == "high"`:
- Do **not** apply the patch.
- Record in `skipped_proposals` with `reason: "high risk requires human confirmation"`.
- Do **not** write `api-fixer-error.json` for this (it is not an error, it is a skip).

## Application Process

For each proposal in `fix-proposal.json` where `target == "api"`, `eligible == true`, and `risk_level in ["low", "medium"]`:

1. **Cross-validate files before any patch:**
   - Collect all files from `files_to_modify`.
   - Validate each against the three-condition allowed file rule (see **Allowed Files**).
   - Collect all files from every `patch_plan[].file` entry.
   - Verify every `patch_plan[].file` is present in `files_to_modify`.
     - If any `patch_plan[].file` is not in `files_to_modify` → **STOP**, write `api-fixer-error.json`.
   - If any file fails Condition 3 → **STOP**, write `api-fixer-error.json`.
   - Do not begin patching until all file validations pass.

2. Read the current content of each validated file.
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

This skill updates only the per-target fields in the current attempt entry.

After successful application (patches applied):

```yaml
phases:
  healing:
    # status remains: proposal_created (NOT changed to applied — orchestrator's job)
    attempts:
      - attempt: <n>
        api_apply_status: applied
        api_apply_summary: qa/changes/<change-id>/healing/api-apply-summary.json
        # applied_files is aggregated by the orchestrator after both fixers complete — NOT set here
```

After no eligible API proposals (no-op):

```yaml
phases:
  healing:
    attempts:
      - attempt: <n>
        api_apply_status: no_op
        api_apply_summary: qa/changes/<change-id>/healing/api-apply-summary.json  # applied: false
```

After forbidden modification attempt or cross-validation failure:

```yaml
phases:
  healing:
    status: failed      # only this skill may set status=failed when it encounters a hard error
    stop_reason: "api-fixer: forbidden file targeted or patch_plan/files_to_modify mismatch"
    attempts:
      - attempt: <n>
        api_apply_status: failed
```

---

## Steps

1. Read `workflow-state.yaml` — verify `phases.healing.status == proposal_created`; STOP if not.
2. Read `healing/fix-proposal.json`.
3. Filter: `target == "api"` and `eligible == true` and `risk_level in ["low", "medium"]`.
4. If no matching proposals: write minimal `api-apply-summary.json` (`applied: false`, `api_apply_status: no_op`), update attempt entry.
5. **Pre-apply file validation (before touching any file):**
   a. For each proposal: collect all `files_to_modify` and all `patch_plan[].file`.
   b. Verify every `patch_plan[].file` is in `files_to_modify` — STOP on mismatch.
   c. Verify every file in `files_to_modify` satisfies Conditions 1, 2, and 3 (see **Allowed Files**) — STOP on failure.
   d. Verify no file is in the forbidden list — STOP on violation.
   e. If any `conftest.py` is targeted, apply the extra conftest rules — STOP on violation.
   f. Write `api-fixer-error.json` if STOP is triggered, set `api_apply_status: failed`.
6. Apply patches (only after all validations pass):
   a. For each validated proposal, apply each `patch_plan` step.
   b. Re-read each modified file to confirm patch applied correctly.
7. Write `qa/changes/<change-id>/healing/api-apply-summary.json` and `qa/changes/<change-id>/healing/api-apply-summary.md`.
8. Update `workflow-state.yaml` attempt entry: set `api_apply_status` and `api_apply_summary` only.
   (`applied_files` is NOT written here — it is an orchestrator-only aggregate field)
   - **Do NOT** set `phases.healing.status = applied`.
9. Report summary to user.

---

## Hard Rules

- **Never** modify files outside the allowed set.
- **Never** modify `app/`, `web/`, or `src/`.
- **Never** change assertion expected values.
- **Never** add `pytest.mark.skip`, `xfail`, or equivalent.
- **Never** delete failing tests.
- **Never** apply a `high` risk proposal automatically.
- **Never** apply a patch whose `patch_plan[].file` is not listed in `files_to_modify`.
- **Never** accept `proposals[].files_to_modify` as authorization alone — require Condition 3 trusted source.
- **Never** set `phases.healing.status = applied` — the orchestrator sets this after all fixers complete.
- **Always** complete all file validations before applying any patch.
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
