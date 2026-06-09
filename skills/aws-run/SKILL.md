---
name: aws-run
description: "AWS M5: Execute API and E2E tests for a change via `aws run --change <change-id>`. Use when the user asks to run tests, execute test suite, or verify a change. Calls pytest for API tests and pytest + Python Playwright (uv run pytest tests/e2e/ -v --headed) for E2E tests. Writes api-result.json, e2e-result.json, summary.md. Never fabricates test results."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify codegen phases are done (`phases.api_codegen.status == done` and/or `phases.e2e_codegen.status == done` per `test_types`).
3. Read `.aws/config.yaml` for change-id and test configuration.
4. If required files are missing, stop and report.
5. Use files as the sole source of truth.

**After completing work:**

1. Write output files:
   - `qa/changes/<change-id>/execution/runs/<batch-id>/api-result.json`
   - `qa/changes/<change-id>/execution/runs/<batch-id>/e2e-result.json`
   - `qa/changes/<change-id>/execution/runs/<batch-id>/summary.md`
   - `qa/changes/<change-id>/execution/api-result.json` (latest pointer)
   - `qa/changes/<change-id>/execution/e2e-result.json` (latest pointer)
   - `qa/changes/<change-id>/execution/summary.md` (latest pointer)
   - `qa/changes/<change-id>/execution/known-product-issues.md` (if codegen wrote one)
2. Update `workflow-state.yaml`:
   - Set `phases.execution.status` = `passed | passed_with_known_issues | failed | skipped`
   - Set `phases.execution.batch_id` = `<YYYYMMDD-HHmmss>` (the current run's batch ID)

---

# Skill: aws-run

## Purpose

Execute generated API and E2E tests for a specific change, produce normalised execution result files, and report a brief summary to the user.

## AWS CLI Prerequisite

This skill calls the **AWS CLI** (`aws`) — the Assurance Workflow Skills CLI, provided by this project. The `aws` binary must be installed and on `PATH` before this skill can run. This is **not** the Amazon Web Services CLI.

To verify:

```bash
aws --version
```

If `aws` is not available, fall back to the direct pytest commands documented in the relevant codegen skill.

## CLI Invocation

This Skill **must** call the AWS CLI. Do not replace this command with MCP or any other mechanism.

```bash
aws run --change <change-id>
```

Example:

```bash
aws run --change REQ-002-user-logout
```

MCP is optional and must not replace the CLI execution chain.

## What the CLI Does

`aws run` is the only trusted execution layer. It:

1. Reads `qa/changes/<change-id>/plans/api-codegen-plan.md` and `e2e-codegen-plan.md` to locate test files.
2. Resolves the project's pytest runner in priority order:
   - `uv run pytest` (when `pyproject.toml` or `uv.lock` exists)
   - `python3 -m pytest`
   - `python -m pytest`
3. Executes **API tests** via pytest with JUnit XML output.
4. Executes **E2E tests** via **pytest-playwright** (`pytest tests/e2e/ -v --headed`), **NOT** `npx playwright test`.
5. Preserves each run under `execution/runs/<batch-id>/` — consecutive runs never overwrite previous results.
6. Parses real execution results — **never fabricates** passed / failed / skipped.
7. Writes normalised result files and a human-readable summary.

### Runner Commands (actual)

| Target | Command |
|--------|---------|
| API | `uv run pytest tests/api/test_*.py --junitxml=...` |
| E2E | `uv run pytest tests/e2e/test_*.py -v --headed --junitxml=...` |

> **Do not use** `python -m pytest` when pytest is only installed in `.venv` (use `uv run pytest`).
> **Do not use** `npx playwright test` for Python Playwright projects.

## Output Files (read after CLI completes)

```
qa/changes/<change-id>/execution/
├── api-result.json          ← latest run (includes batch_id)
├── e2e-result.json
├── summary.md
└── runs/
    └── <YYYYMMDD-HHmmss>/   ← per-run archive (never overwritten)
        ├── api-result.json
        ├── e2e-result.json
        ├── summary.md
        └── raw/
            ├── api.log
            ├── e2e.log
            ├── pytest-report.xml    ← API JUnit XML
            └── e2e-junit.xml        ← E2E JUnit XML (pytest-playwright)
        ├── traces/
        ├── screenshots/
        └── videos/
```

## Steps

1. Call `aws run --change <change-id>` in the terminal.
2. Wait for the command to complete.
3. Read `qa/changes/<change-id>/execution/api-result.json`.
4. Read `qa/changes/<change-id>/execution/e2e-result.json`.
5. Read `qa/changes/<change-id>/execution/summary.md`.
6. Present a brief summary to the user (status, counts, any failures).
7. Update `workflow-state.yaml`: set `phases.execution.status` and `phases.execution.batch_id`.
8. Do **not** generate `failure-analysis.json` — that is the job of `aws-inspect`.

## Known Product Issues During Execution

A passing test suite does not always mean the product has no issues.

If execution or test diagnostics reveal a real product bug that was worked around during codegen, record it in execution outputs.

Examples:

- A direct endpoint returns 500, but the test uses a list/search endpoint as workaround.
- A UI flow is skipped due to a known product issue.
- A backend bug is observed but not fixed in this workflow.

Codegen skills (`aws-api-codegen`, `aws-e2e-codegen`) write workaround records directly to:

```text
qa/changes/<change-id>/execution/known-product-issues.md
```

After `aws run` completes, **check whether this file exists**. If it does, include in `qa/changes/<change-id>/execution/summary.md` the following status block:

```yaml
status: passed_with_known_issues
known_product_issues:
  count: <N>
  files:
    - qa/changes/<change-id>/execution/known-product-issues.md
```

### Valid Execution Status Values

```text
passed
passed_with_known_issues
failed
skipped
```

If known product issues exist, **do not** report the execution as `clean_pass`, `fully_passed`, or `no_risk`.

## Hard Rules

- **Never fabricate** passed / failed / skipped status.
- The CLI result files are the only source of truth.
- If the CLI returns skipped, report the skip reason from the result file.
- If the CLI returns failed, advise the user to run `aws report inspect --change <change-id>`.
- Do **not** invoke MCP as a substitute for the CLI.
- If `known-product-issues.md` exists, always set execution `status` to `passed_with_known_issues`, never `passed`.
