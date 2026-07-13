---
name: aws-fix-proposal
description: "Generate structured fix proposals from inspect/failure-analysis.json for eligible API/E2E test-code failures. Does not modify files."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.inspect.status == done` and `phases.inspect.inspect_mode == primary` and `phases.inspect.classification_performed == true`.
3. Read `qa/changes/<change-id>/inspect/failure-analysis.json` — stop if missing.
4. Read `qa/changes/<change-id>/inspect/failure-summary.md`.
5. Read `qa/changes/<change-id>/execution/execution-manifest.yaml`.
6. Verify `failure-analysis.json.source_batch_id` exactly equals the latest
   `execution-manifest.yaml.batch_id`; stop on missing or mismatched values.
7. Compute SHA256 of the exact `inspect/failure-analysis.json` bytes that will
   be used to generate the proposal.
8. Do **not** read from memory or chat — use files as sole source of truth.

**After completing work:**

1. Verify `qa/changes/<change-id>/healing/fix-proposal.json` exists and is valid JSON.
2. Verify `qa/changes/<change-id>/healing/fix-proposal.md` exists.
3. Verify `fix-proposal.json.source_batch_id` exactly equals both the analysis
   `source_batch_id` and latest manifest `batch_id`.
4. Verify `fix-proposal.json.source_analysis_sha256` exactly equals the current
   `inspect/failure-analysis.json` SHA256.
5. Do not write healing status to `workflow-state.yaml`; `proposal_created` and
   `not_needed` are derived by the CLI from current artifacts.

---

# Skill: aws-fix-proposal

## Purpose

`aws-fix-proposal` is **Phase 10** of the healing loop.

It reads the failure classification output from `aws-inspect` and generates a structured, human-readable fix proposal for every eligible failure. It does **not** modify any test or product code.

## Role Boundary

This skill:

- **May** read test files to understand fix context
- **May** generate patch plans describing what should change
- **Must NOT** apply patches or write to `tests/` or `app/`
- **Must NOT** execute tests or make any system calls
- **Must NOT** modify `inspect/` outputs

The actual code modification is performed by `aws-api-codegen-fixer` (Phase 11A) and `aws-e2e-codegen-fixer` (Phase 11B).

---

## Eligible Failure Categories

Generate a fix proposal **only** for:

| Category | Eligible | Notes |
|----------|:--------:|-------|
| `locator_failure` | ✓ | Always eligible |
| `wait_strategy_failure` | ✓ | Always eligible |
| `test_code_error` | ✓ | Always eligible |
| `test_data_failure` | conditional | Only if test data generation can be fixed without changing product code or assertion expected values |
| `assertion_expectation_error` | review | Eligible only after `aws report reclassify`; proposal must set `needs_review: true` and must not be applied until human approval |
| `environment_failure` | ✗ | `not_eligible` |
| `assertion_failure` | ✗ | `not_eligible` |
| `business_logic_failure` | ✗ | `not_eligible` |
| `case_semantic_failure` | ✗ | `not_eligible` |
| `known_product_issue` | ✗ | `not_eligible` |
| `coverage_gap` | ✗ | `not_eligible` |
| `fuzz_configuration_error` | ✗ | `not_eligible` — fuzz harness files are outside the API/E2E healing loop |
| `fuzz_stateful_failure` | ✗ | `not_eligible` — usually product robustness or case-design review |
| `perf_script_error` | ✗ | `not_eligible` — performance files are outside the API/E2E healing loop |
| `perf_threshold_exceeded` | ✗ | `not_eligible` — product/performance review required |
| `perf_environment` | ✗ | `not_eligible` — environment fix required |
| `product_bug` | ✗ | `not_eligible` |
| `unrelated_existing_failure` | ✗ | `not_eligible` — not in current change scope |
| `unknown` | ✗ | `not_eligible` |

**`test_data_failure` eligibility rule:** Mark as `eligible: true` only if the failure can be resolved by fixing test data generation code **without**:
- modifying product code (`app/`, `web/`, `src/`)
- changing assertion expected values
- deleting or skipping test cases

---

## Proposal Generation Rules

For each **eligible** failure:

1. Identify the exact file(s) to modify (must be in the allowed list for the target).
2. Identify the exact operation needed (see `allowed_operations`).
3. Assess risk level.
4. Write a concrete `patch_plan` with file + operation + description + constraints.
5. Set `verification.rerun_required = true` always.
6. Set `verification.success_case_ids` to the stable `case_id`s (as they appear in `inspect/failure-analysis.json`) that this fix must make pass. This is the human-readable declaration of intent. **The CLI does not trust it as the gate**: healing state is derived from the fresh analysis, proposal identity, and CLI-recorded apply evidence, because the `failure_ids` (FAIL-NNN) labels are agent-authored and can be renumbered across re-inspects.

**Per-target resolution contract (RETRO-009).** Healing is recorded as `resolved` only after the post-rerun re-inspect proves each targeted failure is cleared — either it passes (gone from `failures[]`) or it is explicitly reclassified via `aws report reclassify` (evidence-logged). If a targeted failure is silently downgraded to a non-eligible category without that reclassify stamp, `aws state heal --to resolved` is rejected with `HEAL-TARGET-UNRESOLVED`; loop back for another attempt, reclassify with evidence, or go to `exhausted`. Never treat "patch applied" as "failure resolved".

For any failure where `needs_review == true` (including `assertion_expectation_error`), generate the proposal but mark it review-gated. The fixer MUST NOT apply it until a human approval is recorded with `aws decide --at healing.safety --action accept_risk` or an equivalent supported workflow decision.

**Forbidden operations — always add to `forbidden_operations`:**

```json
[
  "modify_product_code",
  "change_assertion_expected_values",
  "hide_known_product_issue",
  "delete_test_case_without_review"
]
```

**Allowed files (API target):**

```text
tests/api/test_<module>_api.py
tests/api/helpers/<module>_api.py
tests/api/conftest.py
tests/api/adapters/**/*.py
tests/testdata/domain/**/*.py
```

**Allowed files (E2E target):**

```text
tests/e2e/test_<module>_e2e.py
tests/e2e/scripts/<module>_data_setup.py
tests/e2e/conftest.py
tests/e2e/adapters/**/*.py
tests/testdata/domain/**/*.py
```

There is deliberately no `fuzz` or `performance` target in this fixer. Do not generate proposals that modify `tests/fuzz/**` or `tests/perf/**`; those changes require a separate test-maintenance change or an explicit human-approved test-change override.

For each **not_eligible** failure, record it in the `not_eligible` array with a `recommended_next_action`.

---

## fix-proposal.json Schema

```json
{
  "schema_version": "1.0",
  "change_id": "<change-id>",
  "source_analysis": "qa/changes/<change-id>/inspect/failure-analysis.json",
  "source_batch_id": "<exact batch_id from failure-analysis.json and latest execution-manifest.yaml>",
  "source_analysis_sha256": "<SHA256 of the exact current inspect/failure-analysis.json bytes>",
  "created_at": "YYYY-MM-DDTHH:mm:ssZ",
  "summary": {
    "eligible_count": 0,
    "not_eligible_count": 0,
    "targets": {
      "api": 0,
      "e2e": 0
    }
  },
  "proposals": [
    {
      "proposal_id": "FIX-001",
      "failure_ids": ["FAIL-001"],
      "target": "api|e2e",
      "category": "locator_failure|wait_strategy_failure|test_code_error|test_data_failure",
      "eligible": true,
      "risk_level": "low|medium|high",
      "reason": "description of why this is eligible",
      "files_to_modify": ["tests/e2e/test_<module>_e2e.py"],
      "forbidden_files": ["app/**", "web/**", "src/**"],
      "allowed_operations": ["replace_locator", "fix_wait_strategy", "fix_api_call"],
      "forbidden_operations": [
        "modify_product_code",
        "change_assertion_expected_values",
        "hide_known_product_issue",
        "delete_test_case_without_review"
      ],
      "patch_plan": [
        {
          "file": "tests/e2e/test_<module>_e2e.py",
          "operation": "replace|insert|refactor|add_helper",
          "description": "Concrete description of the change needed",
          "constraints": ["must not weaken assertions", "must not delete test"]
        }
      ],
      "verification": {
        "rerun_required": true,
        "command": "aws run --change <change-id>",
        "expected_effect": "test passes with the fix applied",
        "success_case_ids": ["TC_MODULE_020"]
      }
    }
  ],
  "not_eligible": [
    {
      "failure_id": "FAIL-002",
      "target": "api|e2e|fuzz|performance",
      "category": "assertion_failure",
      "reason": "Assertion failure may reflect real product behavior change; cannot fix without human review",
      "recommended_next_action": "developer_fix_required|manual_investigation|environment_fix_required|separate_change_required"
    }
  ]
}
```

---

## fix-proposal.md Content

Write a human-readable Markdown report:

```markdown
# Fix Proposal — <change-id>

**Generated**: <timestamp>
**Source**: inspect/failure-analysis.json
**Eligible fixes**: <N>  **Not eligible**: <N>

---

## Summary

<One-paragraph summary of what failed and what can be auto-fixed.>

---

## Eligible Fixes

### FIX-001 — <category> (<target>)

**Risk**: low|medium|high
**Failures addressed**: FAIL-001
**Files to modify**:
- `tests/e2e/test_<module>_e2e.py`

**Patch plan**:
1. <step 1>
2. <step 2>

**Verification**: Re-run `aws run --change <change-id>` after applying.

---

## Not Eligible Failures

| Failure ID | Category | Reason | Next Action |
|------------|----------|--------|-------------|
| FAIL-002 | assertion_failure | ... | developer_fix_required |

---

## Files Allowed to Modify

- `tests/api/test_<module>_api.py`
- `tests/e2e/test_<module>_e2e.py`

## Files Forbidden to Modify

- `app/**` — product code
- `web/**` — product code
- `src/**` — product code
- `qa/changes/<change-id>/cases/**`
- `qa/changes/<change-id>/plans/**`

---

## Verification Plan

Every applied fix must be verified by re-running:

```bash
aws run --change <change-id>
```

Then re-inspecting:

```bash
aws report inspect --change <change-id>
```
```

---

## Evidence-derived State

Do not update `workflow-state.yaml` for proposal creation. The CLI derives:

- `proposal_created` when a valid proposal's `source_batch_id` matches the fresh
  analysis and active execution manifest.
- `not_needed` when the fresh analysis has no eligible failures.
- `attempts_used` from distinct proposal identities recorded by apply events.

The workflow terminal/gate layer decides whether an unhealable execution failure
requires a stop or human intervention.

---

## Steps

1. Read `workflow-state.yaml` — verify inspect was primary mode with classification.
2. Read `inspect/failure-analysis.json` — stop if missing, if
   `classification_performed == false`, or if its `source_batch_id` does not
   exactly match the latest execution manifest `batch_id`.
3. For each failure in `failures[]`:
   a. Check category against eligibility table.
   b. If eligible: build a `proposal` entry with `patch_plan`.
   c. If not eligible: build a `not_eligible` entry with `recommended_next_action`.
4. Write `healing/fix-proposal.json` (create `healing/` directory if not present).
5. Write `healing/fix-proposal.md`.
6. Verify the proposal's `source_batch_id` still matches the latest analysis and
   manifest, and `source_analysis_sha256` still matches the exact analysis file.
7. Present summary to user.

---

## Hard Rules

- **Never** modify test files — this skill generates proposals only.
- **Never** modify product code.
- **Never** generate a proposal for `known_product_issue`, `coverage_gap`, or `business_logic_failure`.
- **Never** generate a proposal that requires changing assertion expected values.
- **Always** set `verification.rerun_required = true`.
- **Always** include `forbidden_operations` in every proposal.
- **Always** copy the exact current analysis/manifest batch into top-level `source_batch_id`.
- **Always** include top-level `source_analysis_sha256` for the exact analysis
  bytes used; never reuse a proposal after same-batch re-inspection.
- If `fix-proposal.json` would have `eligible_count == 0`, stop — the CLI derives
  `not_needed`; do not write healing state or proceed to Phase 11.

---

## Example

**E2E `AttributeError: Page object has no attribute 'wait_for_response'`**

```json
{
  "proposal_id": "FIX-001",
  "failure_ids": ["FAIL-003"],
  "target": "e2e",
  "category": "test_code_error",
  "eligible": true,
  "risk_level": "low",
  "reason": "Incorrect Playwright API call — Page has no wait_for_response; correct API is expect_response context manager",
  "files_to_modify": ["tests/e2e/conftest.py"],
  "forbidden_files": ["app/**", "web/**", "src/**"],
  "allowed_operations": ["replace_playwright_api_call"],
  "forbidden_operations": [
    "modify_product_code",
    "change_assertion_expected_values",
    "hide_known_product_issue",
    "delete_test_case_without_review"
  ],
  "patch_plan": [
    {
      "file": "tests/e2e/conftest.py",
      "operation": "replace",
      "description": "Replace page.wait_for_response(url) with 'with page.expect_response(url) as response_info:' context manager pattern",
      "constraints": [
        "must not change assertion logic",
        "must not delete the test function"
      ]
    }
  ],
  "verification": {
    "rerun_required": true,
    "command": "aws run --change <change-id>",
    "expected_effect": "E2E test passes without AttributeError"
  }
}
```
