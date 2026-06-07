---
name: awe-inspect
description: "AWE M5: Inspect execution results and classify test failures via `awe report inspect --change <change-id>`. Use when tests have failed and the user wants to understand why. Classifies failures into categories (locator, assertion, environment, etc.) and writes failure-analysis.json and failure-summary.md."
---

# Skill: awe-inspect

## Purpose

Inspect execution results and artifacts for a specific change, classify failures by category, and present a failure summary to the user.

## CLI Invocation

This Skill **must** call the AWE CLI. Do not replace this command with MCP or any other mechanism.

```bash
awe report inspect --change <change-id>
```

Example:

```bash
awe report inspect --change REQ-002-user-logout
```

MCP is optional and must not replace the CLI execution chain.

## What the CLI Does

`awe report inspect` reads execution artifacts and classifies each failure:

1. Reads `execution/api-result.json` and `execution/e2e-result.json`.
2. Reads raw logs, traces, screenshots, and videos.
3. Reads associated `case.yaml` and test source files.
4. Classifies each failure into a defined category.
5. Writes `failure-analysis.json` and `failure-summary.md`.

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
| unknown | review |

## Output Files (read after CLI completes)

```
qa/changes/<change-id>/execution/
├── failure-analysis.json
└── failure-summary.md
```

## Steps

1. Confirm `awe run --change <change-id>` has already been executed.
2. Call `awe report inspect --change <change-id>` in the terminal.
3. Wait for the command to complete.
4. Read `qa/changes/<change-id>/execution/failure-analysis.json`.
5. Read `qa/changes/<change-id>/execution/failure-summary.md`.
6. Present the failure summary to the user (category breakdown, hard fails, evidence links).
7. Do **not** generate a Fix Proposal — that is the job of `awe-fix-proposal`.

## Hard Rules

- **Never classify failures yourself** — the CLI is the only trusted classifier.
- **Never fabricate** category assignments.
- If `failure-analysis.json` is absent, run `awe report inspect` again rather than guessing.
- Do **not** invoke MCP as a substitute for the CLI.
- Environment failures must **not** enter a Fix Proposal pipeline.
- Assertion failures must **not** have their expected values auto-changed.
