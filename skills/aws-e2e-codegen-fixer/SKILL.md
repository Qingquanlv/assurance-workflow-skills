---
name: aws-e2e-codegen-fixer
description: "Apply approved E2E test-code fixes from healing/fix-proposal.json. Modifies only generated E2E test files allowed by the proposal."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.healing.status == proposal_created`.
3. Read `qa/changes/<change-id>/healing/fix-proposal.json` — stop if missing.
4. Read `qa/changes/<change-id>/inspect/failure-analysis.json`.
5. Read `qa/changes/<change-id>/codegen/e2e-codegen-summary.md` to confirm which files were generated.
6. Do **not** apply patches not listed in `fix-proposal.json`.

**After completing work:**

1. Verify `healing/e2e-apply-summary.json` exists and is valid JSON.
2. Verify `healing/e2e-apply-summary.md` exists.
3. Verify every modified file is in the allowed list.
4. Update `workflow-state.yaml`: `phases.healing.status = applied`.

---

# Skill: aws-e2e-codegen-fixer

## Purpose

`aws-e2e-codegen-fixer` is **Phase 11B** of the healing loop.

It reads `healing/fix-proposal.json`, filters to proposals with `target == "e2e"` and `eligible == true`, and applies the approved patches to generated E2E test files.

## Role Boundary

This skill:

- **May** modify files listed in the allowed file set (see below)
- **May** only apply operations described in `fix-proposal.json.proposals[].patch_plan`
- **Must NOT** modify product code (`app/`, `web/`, `src/`)
- **Must NOT** change assertion expected values
- **Must NOT** skip or delete failing tests
- **Must NOT** modify API test files
- **Must NOT** modify unrelated test files outside the change scope

---

## Allowed Files

A file is eligible for modification only if **all** of the following are true:

1. It matches one of these patterns:
   ```text
   tests/e2e/test_<module>_e2e.py
   tests/e2e/scripts/<module>_data_setup.py
   tests/e2e/conftest.py
   tests/fixtures/**/*.py
   ```

2. It appears in **at least one** of:
   - `phases.e2e_codegen.generated_tests.files` in `workflow-state.yaml`
   - `proposals[].files_to_modify` in `fix-proposal.json`
   - `codegen/e2e-codegen-summary.md` generated/reused files section

If a proposal targets a file not satisfying both conditions → **STOP**, write `healing/e2e-fixer-error.json`, do not apply.

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
tests/api/**
```

If a proposal in `fix-proposal.json` requires modifying any forbidden file:

1. **STOP** immediately.
2. Write `qa/changes/<change-id>/healing/e2e-fixer-error.json`.
3. Do **not** apply any patch.
4. Do **not** rerun.
5. Update `workflow-state.yaml`: `phases.healing.status = failed`.

---

## Forbidden Operations

Never perform:

- Modify product code
- Change assertion expected values (e.g., changing `expect(locator).to_have_text("Success")` to `expect(locator).to_have_text("OK")`)
- Delete failing test functions
- Add `pytest.mark.skip`
- Add `pytest.mark.xfail`
- Add `@pytest.mark.skip`
- Lower assertion strength (e.g., `expect(locator).to_be_visible()` → no assertion)
- Mark known product issues as passing
- Swap one locator for a less specific one to avoid a real product failure

---

## Allowed Operations

Permitted repairs:

- Fix locator strategy (wrong CSS selector, wrong `data-testid`, wrong role, wrong text matcher)
- Replace brittle wait strategy: `page.wait_for_response(url)` → `page.expect_response(url)` context manager
- Replace `page.wait_for_timeout(ms)` with `expect(locator).to_be_visible(timeout=ms)`
- Fix fixture name conflicts
- Fix login flow wait strategy
- Fix cleanup fixture (wrong teardown order, missing cleanup)
- Fix test data setup script (`scripts/<module>_data_setup.py`)
- Fix Playwright Python API usage (deprecated or incorrect method names)
- Fix import paths

---

## Application Process

For each proposal in `fix-proposal.json` where `target == "e2e"` and `eligible == true`:

1. Read the current content of each file in `files_to_modify`.
2. Validate the file is in the allowed set (see **Allowed Files**).
3. Apply each `patch_plan` step sequentially:
   - `replace`: replace identified code pattern with corrected version
   - `insert`: add new code at specified location
   - `refactor`: restructure existing code without changing behavior
   - `add_helper`: add a new helper function
4. After each file modification, re-read the file to verify the patch applied correctly.
5. Record the modification in `healing/e2e-apply-summary.json`.

---

## Output Files

Write after all eligible proposals are processed:

**`qa/changes/<change-id>/healing/e2e-apply-summary.json`:**

```json
{
  "schema_version": "1.0",
  "change_id": "<change-id>",
  "target": "e2e",
  "applied": true,
  "applied_proposals": [
    {
      "proposal_id": "FIX-003",
      "files_modified": ["tests/e2e/test_checkout_e2e.py"],
      "operations_applied": ["fix_wait_strategy"],
      "notes": "Replaced page.wait_for_response with expect_response context manager"
    }
  ],
  "modified_files": ["tests/e2e/test_checkout_e2e.py"],
  "skipped_proposals": [
    {
      "proposal_id": "FIX-001",
      "reason": "target is api, not e2e"
    }
  ],
  "forbidden_attempts": [],
  "rerun_required": true,
  "next_action": "run_aws_run"
}
```

**`qa/changes/<change-id>/healing/e2e-apply-summary.md`:**

```markdown
# E2E Codegen Fixer — Apply Summary

**Change**: <change-id>
**Applied at**: <timestamp>
**Proposals applied**: <N>
**Files modified**: <N>

## Applied Fixes

### FIX-003 — wait_strategy_failure (e2e)

**File**: `tests/e2e/test_checkout_e2e.py`
**Operation**: fix_wait_strategy
**Description**: Replaced `page.wait_for_response(url)` with `page.expect_response(url)` context manager

---

## Skipped Proposals

| Proposal | Reason |
|----------|--------|
| FIX-001 | target=api, not handled by this fixer |

---

## Next Action

Re-run tests: `aws run --change <change-id>`
```

---

## Error Output

If a forbidden file is targeted or a forbidden operation is required, write:

**`qa/changes/<change-id>/healing/e2e-fixer-error.json`:**

```json
{
  "schema_version": "1.0",
  "change_id": "<change-id>",
  "target": "e2e",
  "error": "forbidden_file_targeted|forbidden_operation_required",
  "proposal_id": "FIX-003",
  "forbidden_file": "app/views/checkout.py",
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
          - tests/e2e/test_<module>_e2e.py
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
3. Filter: `target == "e2e"` and `eligible == true`.
4. If no E2E proposals: write minimal `e2e-apply-summary.json` with `applied: false`, update `workflow-state.yaml`.
5. For each E2E proposal:
   a. Validate all `files_to_modify` are in the allowed set.
   b. If any forbidden file: write `e2e-fixer-error.json`, STOP.
   c. Apply each `patch_plan` step.
   d. Verify patch was applied (re-read file).
6. Write `healing/e2e-apply-summary.json` and `healing/e2e-apply-summary.md`.
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
- **Always** set `rerun_required: true` in `e2e-apply-summary.json`.
- If `phases.healing.status != proposal_created`, stop and report.

---

## Example

**E2E wait strategy failure — brittle wait pattern:**

```text
Failure: test_checkout_completes_successfully — TimeoutError waiting for response
Category: wait_strategy_failure
Analysis: page.wait_for_response is not a valid Playwright Page method in the Python API;
          correct pattern is page.expect_response() context manager
```

Fix proposal says:
```json
{
  "proposal_id": "FIX-003",
  "target": "e2e",
  "patch_plan": [
    {
      "file": "tests/e2e/test_checkout_e2e.py",
      "operation": "replace",
      "description": "Replace page.wait_for_response(url) with with page.expect_response(url) as resp: / response = resp.value",
      "constraints": [
        "must not change what URL is being waited for",
        "must not change downstream assertions on response"
      ]
    }
  ]
}
```

This skill:
1. Reads `tests/e2e/test_checkout_e2e.py`
2. Validates file is in `phases.e2e_codegen.generated_tests.files`
3. Locates `page.wait_for_response(url)` pattern
4. Replaces with:
   ```python
   with page.expect_response(url) as response_info:
       page.click(submit_button)
   response = response_info.value
   ```
5. Re-reads the file to confirm change
6. Records in `e2e-apply-summary.json`

**E2E locator failure — stale/wrong selector:**

```text
Failure: test_product_list_shows_items — TimeoutError: Timeout 5000ms exceeded waiting for locator('.product-card')
Category: locator_failure
Analysis: Product card class changed from .product-card to .product-item in recent frontend update
```

Fix proposal says:
```json
{
  "proposal_id": "FIX-004",
  "target": "e2e",
  "patch_plan": [
    {
      "file": "tests/e2e/test_product_e2e.py",
      "operation": "replace",
      "description": "Update CSS selector from .product-card to [data-testid='product-item'] for stable locator",
      "constraints": [
        "must use data-testid if available",
        "must not change the assertion on the located element"
      ]
    }
  ]
}
```
