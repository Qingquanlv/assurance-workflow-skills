---
name: aws-inspect
description: "AWS M5: Inspect execution results and classify test failures via `aws report inspect --change <change-id>`. Use when tests have failed and the user wants to understand why. Classifies failures into categories (locator, assertion, environment, etc.) and writes qa/changes/<change-id>/execution/failure-analysis.json and failure-summary.md."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.execution.status` is set (execution must have run).
3. Read input files from disk: `execution/api-result.json`, `execution/e2e-result.json`, `execution/known-product-issues.md` (if present).
4. If execution result files are missing, stop and report.
5. Use files as the sole source of truth.

**After completing work:**

1. Write output files (if failures detected):
   - `qa/changes/<change-id>/execution/failure-analysis.json`
   - `qa/changes/<change-id>/execution/failure-summary.md`
   - `qa/changes/<change-id>/inspect/known-product-issues.md` (if known issues found)
   - `qa/changes/<change-id>/inspect/failure-analysis.json` (if known issues found)
2. Update `workflow-state.yaml`:
   - Set `phases.inspect.status = done`
   - Update `phases.execution.status` if classification changes the result
   - Append to `known_product_issues` if any are discovered

---

# Skill: aws-inspect

## Purpose

Inspect execution results and artifacts for a specific change, classify failures by category, and present a failure summary to the user.

## AWS CLI Prerequisite

This skill calls the **AWS CLI** (`aws`) — the Assurance Workflow Skills CLI, provided by this project. The `aws` binary must be installed and on `PATH`. This is **not** the Amazon Web Services CLI.

To verify:

```bash
aws --version
```

If `aws` is not available, read raw execution result files directly and report failure summaries without classification.

## CLI Invocation

This Skill **must** call the AWS CLI. Do not replace this command with MCP or any other mechanism.

```bash
aws report inspect --change <change-id>
```

Example:

```bash
aws report inspect --change REQ-002-user-logout
```

MCP is optional and must not replace the CLI execution chain.

## What the CLI Does

`aws report inspect` reads execution artifacts and classifies each failure:

1. Reads `execution/api-result.json` and `execution/e2e-result.json`.
2. Reads raw logs, traces, screenshots, and videos.
3. Reads associated `case.yaml` and test source files.
4. Classifies each failure into a defined category.
5. Writes `failure-analysis.json` and `failure-summary.md` into `qa/changes/<change-id>/execution/`.

## Failure Categories

| Category | Fix Proposal |
|----------|:------------:|
| locator_failure | ✓ |
| wait_strategy_failure | ✓ |
| test_code_error | ✓ |
| test_data_failure | review |
| environment_failure | ✗ |
| assertion_failure | ✗ |
| business_logic_failure | ✗ |
| case_semantic_failure | ✗ |
| known_product_issue | ✗ |
| coverage_gap | ✗ |
| unknown | review |

## Known Product Issue Classification

When test execution reveals a real product behavior problem but tests use a workaround to continue, classify it as a known product issue — not as a test failure.

Supported categories:

```text
product_bug
known_product_issue
coverage_gap
test_bug
test_data_issue
environment_issue
unknown
```

Examples:

- Endpoint returns 500 due to backend serialization error.
- Test validates behavior through an alternate endpoint because the direct endpoint is broken.
- Product behavior is incorrect but not blocking the remaining test suite.

### Output Files for Known Issues

Write known product issues to:

```text
qa/changes/<change-id>/inspect/known-product-issues.md
qa/changes/<change-id>/inspect/failure-analysis.json
```

Each known issue entry in `failure-analysis.json` must include:

```json
{
  "id": "KPI-001",
  "category": "known_product_issue",
  "severity": "major",
  "endpoint": "GET /api/v1/menu/get",
  "symptom": "returns 500",
  "root_cause": "raw ORM object returned through Success(data=result) without serialization",
  "workaround": "tests verify detail/update result through GET /api/v1/menu/list",
  "coverage_gap": "direct GET /api/v1/menu/get endpoint remains unverified",
  "status": "open",
  "next_action": "fix backend serialization in get_menu"
}
```

If known product issues exist, the workflow final summary must **not** say `no risk`, `fully clean`, or `clean pass`.

## Output Files (read after CLI completes)

```
qa/changes/<change-id>/execution/
├── failure-analysis.json
└── failure-summary.md

qa/changes/<change-id>/inspect/   ← written when known product issues are detected
├── known-product-issues.md
└── failure-analysis.json
```

`execution/` holds both raw execution results and the CLI-generated failure analysis files.

## Steps

1. Confirm `aws run --change <change-id>` has already been executed.
2. Call `aws report inspect --change <change-id>` in the terminal.
3. Wait for the command to complete.
4. Read `qa/changes/<change-id>/execution/failure-analysis.json`.
5. Read `qa/changes/<change-id>/execution/failure-summary.md`.
6. Present the failure summary to the user (category breakdown, hard fails, evidence links).
7. Update `workflow-state.yaml`: set `phases.inspect.status = done`; if known product issues were found, append to `known_product_issues` list.
8. Do **not** generate fix proposals — `locator_failure`, `wait_strategy_failure`, `test_code_error` may be fixed by re-running codegen; `known_product_issue`, `coverage_gap`, `assertion_failure`, `business_logic_failure` require a product or case fix outside this skill.

## Hard Rules

- **Never classify failures yourself** — the CLI is the only trusted classifier.
- **Never fabricate** category assignments.
- If `execution/failure-analysis.json` is absent, run `aws report inspect` again rather than guessing.
- Do **not** invoke MCP as a substitute for the CLI.
- Environment failures must **not** enter a Fix Proposal pipeline.
- Assertion failures must **not** have their expected values auto-changed.
- `known_product_issue` and `coverage_gap` categories must **not** enter a Fix Proposal pipeline — they require a product fix, not a test fix.
- If known product issues exist, **never** report the overall result as `no risk`, `clean`, or `fully passed`.
