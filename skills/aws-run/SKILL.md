---
name: aws-run
description: "AWE M5: Execute API and E2E tests for a change via `awe run --change <change-id>`. Use when the user asks to run tests, execute test suite, or verify a change. Calls pytest for API tests and pytest + Python Playwright (uv run pytest tests/e2e/ -v --headed) for E2E tests. Writes api-result.json, e2e-result.json, summary.md. Never fabricates test results."
---

# Skill: aws-run

## Purpose

Execute generated API and E2E tests for a specific change, produce normalised execution result files, and report a brief summary to the user.

## AWE CLI Prerequisite

This skill calls the **AWE CLI** (`awe`) — the Assurance Workflow Engine, a separate package from this project. The `awe` binary must be installed and on `PATH` before this skill can run. It is distinct from the `aws` prefix used for skill/agent names in this project.

To verify:

```bash
awe --version
```

If `awe` is not available, fall back to the direct pytest commands documented in the relevant codegen skill.

## CLI Invocation

This Skill **must** call the AWE CLI. Do not replace this command with MCP or any other mechanism.

```bash
awe run --change <change-id>
```

Example:

```bash
awe run --change REQ-002-user-logout
```

MCP is optional and must not replace the CLI execution chain.

## What the CLI Does

`awe run` is the only trusted execution layer. It:

1. Reads `qa/changes/<change-id>/plans/api-codegen-plan.md` and `e2e-codegen-plan.md` to locate test files.
2. Executes `pytest` for API tests and `pytest + Python Playwright` for E2E tests (`uv run pytest tests/e2e/ -v --headed`).
3. Preserves raw pytest reports and pytest-playwright artifacts in `execution/raw/`.
4. Parses real execution results — **never fabricates** passed / failed / skipped.
5. Writes normalised result files and a human-readable summary.

## Output Files (read after CLI completes)

```
qa/changes/<change-id>/execution/
├── api-result.json
├── e2e-result.json
├── summary.md
├── raw/
│   ├── api.log
│   ├── e2e.log
│   ├── pytest-report.xml
│   └── pytest-report.json
├── traces/          ← pytest-playwright traces if produced
├── screenshots/     ← pytest-playwright screenshots if produced
└── videos/          ← pytest-playwright videos if produced
```

## Steps

1. Call `awe run --change <change-id>` in the terminal.
2. Wait for the command to complete.
3. Read `qa/changes/<change-id>/execution/api-result.json`.
4. Read `qa/changes/<change-id>/execution/e2e-result.json`.
5. Read `qa/changes/<change-id>/execution/summary.md`.
6. Present a brief summary to the user (status, counts, any failures).
7. Do **not** generate `failure-analysis.json` — that is the job of `aws-inspect`.

## Hard Rules

- **Never fabricate** passed / failed / skipped status.
- The CLI result files are the only source of truth.
- If the CLI returns skipped, report the skip reason from the result file.
- If the CLI returns failed, advise the user to run `awe report inspect --change <change-id>`.
- Do **not** invoke MCP as a substitute for the CLI.
