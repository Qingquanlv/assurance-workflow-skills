---
name: aws-run
description: "AWS M5: Execute quality targets for a change via `aws run --change <change-id>`. Runs API (pytest + coverage), E2E (pytest-playwright), Fuzz (schemathesis via pytest), and Performance (Locust) per selected_targets. CLI writes normalised results to execution/runs/<batch-id>/ (api/e2e/fuzz/performance/coverage-result.json, summary.md, quality-gate-result.json, execution-manifest.yaml) plus latest pointers under execution/. Never fabricates test results or coverage numbers."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify codegen phases are done (`phases.api_codegen.status == done` and/or `phases.e2e_codegen.status == done` per `test_types`).
3. Resolve `selected_targets` (see **Selected Targets Resolution**).
4. Read `.aws/config.yaml` for change-id and test configuration.
5. Verify **Assurance Workflow Skills CLI identity** (see **AWS CLI Identity Check**) before invoking `aws run`.
6. If required files are missing, stop and report.
7. Use files as the sole source of truth.

**After completing work:**

1. Resolve `batch_id` from CLI output (see **Batch ID Resolution**) — never guess from wall clock alone.
2. Verify the CLI wrote (do not synthesize) result files per **selected_targets**:

   **Always required:**
   - `qa/changes/<change-id>/execution/runs/<batch-id>/summary.md`
   - `qa/changes/<change-id>/execution/summary.md` (latest pointer)

   **If `selected_targets.e2e == true`:**
   - `qa/changes/<change-id>/execution/runs/<batch-id>/e2e-result.json`
   - `qa/changes/<change-id>/execution/e2e-result.json` (latest pointer)

   **If `selected_targets.fuzz == true`:**
   - `qa/changes/<change-id>/execution/runs/<batch-id>/fuzz-result.json`
   - `qa/changes/<change-id>/execution/fuzz-result.json` (latest pointer)

   **If `selected_targets.performance == true`:**
   - `qa/changes/<change-id>/execution/runs/<batch-id>/performance-result.json`
   - `qa/changes/<change-id>/execution/performance-result.json` (latest pointer)

   **Coverage (derived from API — always written by CLI, not a separate selected target):**
   - `qa/changes/<change-id>/execution/runs/<batch-id>/coverage-result.json`
   - `qa/changes/<change-id>/execution/coverage-result.json` (latest pointer)
   - When `selected_targets.api == false`, coverage is `status: SKIPPED` with `skip_reason: api_unselected`.
   - When `pytest-cov` is unavailable or `coverage.enabled == false`, coverage is `available: false` / `status: SKIPPED`. Coverage absence is a **warning**, never a hard failure.

   **Quality gate (always written by CLI after run):**
   - `qa/changes/<change-id>/execution/runs/<batch-id>/quality-gate-result.json`
   - `qa/changes/<change-id>/execution/quality-gate-result.json` (latest pointer)

   Do **not** fail because an unselected target result file is absent.

   **Fallback mode:** direct pytest fallback does **not** produce normalised `api-result.json` / `e2e-result.json` / `fuzz-result.json` / `performance-result.json`. Do not fabricate them. See **Fallback Mode Boundary**.

3. Verify or write execution manifest:
   - **Primary mode:** CLI writes canonical `execution-manifest.yaml` (map-shaped `result_files` + `selected_targets`) to both `runs/<batch-id>/` and latest pointer. Skill **verifies** it — do not overwrite CLI paths.
   - **Skill extended format (optional augment):** After verifying CLI batch files exist, skill may rewrite the latest pointer with `primary_runner`, `layer_results`, `warnings`, `final_status` — but `primary_runner.result_files` **must** list every batch file path under `execution/runs/<batch-id>/` for each selected target.
   - **Fallback mode:** skill writes manifest with `fallback_runner.used: true`.
4. Snapshot known product issues if the change-level record exists:
   - Read `qa/changes/<change-id>/known-product-issues.md` (source of truth; created before codegen by human/reviewer workflow; codegen may append implementation notes only when already acknowledged)
   - Copy into `qa/changes/<change-id>/execution/runs/<batch-id>/known-product-issues.md`
   - Copy into `qa/changes/<change-id>/execution/known-product-issues.md` (latest pointer)
5. Update `workflow-state.yaml`:
   - Set `phases.execution.status` = `PASS | PASS_WITH_WARNINGS | FAIL | SKIPPED`
   - Set `phases.execution.batch_id` = resolved `batch_id` from CLI output (not guessed)
   - If `final_status == PASS_WITH_WARNINGS`, downstream workflow final status must be `completed_with_warnings`, not `completed`

---

# Skill: aws-run

## Purpose

Execute generated API, E2E, Fuzz, and Performance tests for a specific change (per `selected_targets`), produce normalised execution result files under `execution/runs/<batch-id>/`, and report a brief summary to the user.

## Skill vs CLI Boundary

This skill **does not synthesize normalised result files itself**. It invokes the Assurance Workflow Skills CLI (or permitted fallback), then verifies the CLI-owned outputs including `execution-manifest.yaml`.

**Primary mode (CLI):**

- The CLI (`aws run`) is the trusted execution layer for normalised `api-result.json` / `e2e-result.json` / `fuzz-result.json` / `performance-result.json` / `coverage-result.json` / `summary.md` / `quality-gate-result.json`.
- The CLI writes `execution-manifest.yaml` (canonical map format) in primary mode. The skill reads and verifies it, may augment the latest pointer with extended metadata, snapshots `known-product-issues.md`, and reports.

**Fallback mode (direct pytest):**

- Direct pytest fallback does **not** write normalised `api-result.json` / `e2e-result.json`.
- When fallback is used:
  - Write `execution-manifest.yaml`
  - Write fallback raw logs under `execution/runs/<batch-id>/raw/`
  - Do **not** fabricate normalised result files
  - `final_status = PASS_WITH_WARNINGS` if fallback passed; `FAIL` if fallback failed
  - User-facing summary must state fallback mode was used and normalised CLI result files are unavailable

**If primary CLI fails to write expected result files:**

- Record failure in `execution-manifest.yaml`
- Set `final_status = FAIL` (or apply fallback per **Runner Mode**)
- **Never fabricate** `api-result.json` or `e2e-result.json`

## AWS CLI Identity Check

This skill calls the **Assurance Workflow Skills CLI** (`aws`) — **not** the Amazon Web Services CLI.

Before running `aws run --change <change-id>`, run:

```bash
aws --version
```

**Hard rule:** The output **must** identify the Assurance Workflow Skills CLI.

If `aws --version` indicates Amazon Web Services CLI, or does **not** identify Assurance Workflow Skills CLI:

- Do **not** run `aws run --change <change-id>`
- Set `primary_runner.status = skipped`
- Set `primary_runner.exit_code = null`
- Set `fallback_runner.reason = aws_cli_invalid`
- If fallback is allowed → run fallback per **Runner Mode**; `final_status` may be `PASS_WITH_WARNINGS` if fallback passes
- If fallback is not allowed → `final_status = FAIL`

If `aws` is not on `PATH` at all → `fallback_runner.reason = aws_cli_missing` (same fallback rules apply).

## Selected Targets Resolution

`selected_targets` in `execution-manifest.yaml` must reflect what this run actually executes.

Resolution order:

1. `workflow-state.yaml` — codegen phases done per `test_types` (`api_codegen`, `e2e_codegen`)
2. `.aws/config.yaml` — `test_types` / selected targets
3. Presence of plan + codegen output files (`api-codegen-plan.md`, `e2e-codegen-plan.md`, generated tests)
4. CLI result metadata (when primary mode succeeds)

Rules:

- If `phases.api_codegen.status != done` → `selected_targets.api = false`
- If `phases.e2e_codegen.status != done` → `selected_targets.e2e = false`
- If sources disagree, record a warning in `execution-manifest.yaml` and prefer `workflow-state.yaml` + CLI metadata
- Do not require E2E result files when `selected_targets.e2e == false`
- Do not require API result files when `selected_targets.api == false`

## Batch ID Resolution

Never guess `batch_id` from wall clock alone.

Resolution order:

1. Read `batch_id` from `execution/api-result.json` or `execution/e2e-result.json` (whichever exists for selected targets).
2. If both exist, they **must** match. If mismatch → `final_status = FAIL`.
3. If latest result files lack `batch_id`, locate the newest `execution/runs/<batch-id>/` directory created by the current CLI invocation.
4. If ambiguous → `final_status = FAIL`.
5. Use the resolved `batch_id` for manifest paths and `phases.execution.batch_id`.

## AWS CLI Prerequisite

The Assurance Workflow Skills `aws` binary must be installed and on `PATH`. Apply **AWS CLI Identity Check** before every run — `aws --version` alone is insufficient if it identifies Amazon AWS CLI.

If the correct CLI is not available, do **not** silently fall back. Apply **Runner Mode** rules.

## Runner Mode

**Primary mode:**

- Run **AWS CLI Identity Check** first.
- If identity check passes, attempt `aws run --change <change-id>`.
- If identity check fails, skip primary and apply fallback rules.

**Fallback mode:**

- Direct pytest fallback is allowed **only when**:
  - `allow_direct_pytest_fallback: true` is set in `.aws/config.yaml`, or
  - the user explicitly accepts the fallback risk.
- Fallback direct pytest must run **only selected targets**:
  - Do **not** run E2E fallback when `selected_targets.e2e == false`
  - Do **not** run API fallback when `selected_targets.api == false`
- Fallback does **not** write normalised `api-result.json` / `e2e-result.json` — see **Fallback Mode Boundary** above.
- If fallback is used and passes, `final_status` must be `PASS_WITH_WARNINGS`, never `PASS`.
- If fallback is not allowed and primary cannot run (`aws_cli_missing`, `aws_cli_invalid`), `final_status` must be `FAIL`.
- Record the chosen mode in `execution-manifest.yaml` (`primary_runner` / `fallback_runner`).

## Fallback Mode Boundary

When `fallback_runner.used == true`:

- Write raw logs to `execution/runs/<batch-id>/raw/` (e.g. `api.log`, `e2e.log`, JUnit XML if pytest produced them)
- Write `execution-manifest.yaml` with `fallback_runner` details
- Do **not** fabricate normalised `api-result.json` or `e2e-result.json`
- Optionally write skill-owned `execution/run-summary-note.md` explaining fallback mode — do **not** rewrite CLI-owned `summary.md`
- `final_status = PASS_WITH_WARNINGS` if fallback passed; `FAIL` if fallback failed

## CLI Invocation

This Skill **must** run **AWS CLI Identity Check** before invoking primary mode.

If identity check passes, attempt:

```bash
aws run --change <change-id>
```

Example:

```bash
aws run --change REQ-002-user-logout
```

If identity check fails, skip primary mode and apply **Runner Mode** fallback rules.

MCP is optional and must not replace the CLI execution chain.

## What the CLI Does

`aws run` is the only trusted execution layer. It:

1. Reads `qa/changes/<change-id>/plans/api-codegen-plan.md` and `e2e-codegen-plan.md` to locate test files.
2. Resolves the project's pytest runner in priority order:
   - `uv run pytest` (when `pyproject.toml` or `uv.lock` exists)
   - `python3 -m pytest`
   - `python -m pytest`
3. Executes **API tests** via pytest with JUnit XML output. When `coverage.enabled` and `pytest-cov` is detected (via `pytest --help`), it also passes `--cov=<target_package> --cov-branch --cov-report=json:... --cov-report=xml:...` and normalises the result into `coverage-result.json`. **Coverage is collected only during the API pytest run** — E2E (playwright) is not counted.
4. Executes **E2E tests** via **pytest-playwright** (`pytest tests/e2e/ -v --headed`), **NOT** `npx playwright test`.
5. Executes **Fuzz tests** (M3) via pytest against `tests/fuzz/` (schemathesis runs on the pytest infra). Requires `schemathesis` to be importable; if `tests/fuzz/` is empty or schemathesis is missing, `fuzz-result.json` is `SKIPPED`.
6. Executes **Performance tests** (M3) via **Locust headless** against locustfiles under `tests/perf/`. The runner resolves Locust as `uv run locust` → `python3 -m locust` → `locust`. It discovers execution files from `tests/perf/locustfile*.py`, not from `performance-codegen-plan.md`; thresholds and load profile come from selected `type: Performance` cases, with `.aws/config.yaml` defaults used only for missing load fields. Each scenario's verdict is derived from the Locust `_stats.csv` (measured p95 / error_rate) vs. the case's absolute thresholds. If Locust is unavailable, `tests/perf/` is empty, or no traffic is recorded, `performance-result.json` is `SKIPPED`.
7. Preserves each run under `execution/runs/<batch-id>/` — consecutive runs never overwrite previous results.
8. Parses real execution results — **never fabricates** passed / failed / skipped or performance measurements.
9. Writes normalised result files and a human-readable summary.

### Runner Commands (actual)

Primary mode (CLI) — per selected targets:

| Target | When | Command |
|--------|------|---------|
| API | `selected_targets.api == true` | `uv run pytest tests/api/test_*.py --junitxml=...` |
| E2E | `selected_targets.e2e == true` | `uv run pytest tests/e2e/test_*.py -v --headed --junitxml=...` |
| Fuzz | `selected_targets.fuzz == true` | `uv run pytest tests/fuzz/ --junitxml=...` (M3) |
| Performance | `selected_targets.performance == true` | `uv run locust -f tests/perf/locustfile*.py --headless -u <case users> -r <case rate> -t <case run_time>s --host <base_url> --csv ...` (M3) |

Required Python packages by layer: API/E2E → `pytest`, `pytest-playwright`; coverage → `pytest-cov`; Fuzz → `schemathesis`; Performance → `locust`. Missing packages degrade the corresponding layer to `SKIPPED` (a warning), never a hard `FAIL`.

Fallback mode (direct pytest) — same target filter; run only selected targets.

> **Do not use** `python -m pytest` when pytest is only installed in `.venv` (use `uv run pytest`).
> **Do not use** `npx playwright test` for Python Playwright projects.

## Output Files (read after CLI completes)

Per-run files depend on `selected_targets`. Unselected target result files may be absent — that is normal.

```
qa/changes/<change-id>/execution/
├── api-result.json              ← latest (if selected_targets.api)
├── e2e-result.json              ← latest (if selected_targets.e2e)
├── coverage-result.json         ← latest (always; SKIPPED when api=false or pytest-cov unavailable)
├── fuzz-result.json             ← latest (if selected_targets.fuzz)
├── performance-result.json      ← latest (if selected_targets.performance)
├── quality-gate-result.json     ← latest (always; CLI-computed gate)
├── summary.md                   ← latest (CLI-owned; skill verifies, does not rewrite)
├── execution-manifest.yaml      ← latest pointer (CLI-written in primary mode)
├── run-summary-note.md          ← optional skill-owned fallback note
├── known-product-issues.md      ← snapshot of change-level record (if present)
└── runs/
    └── <batch-id>/               ← resolved from CLI output, not guessed
        ├── api-result.json       ← if selected_targets.api (primary mode only)
        ├── e2e-result.json       ← if selected_targets.e2e (primary mode only)
        ├── coverage-result.json  ← always (primary mode; SKIPPED when api=false)
        ├── fuzz-result.json       ← if selected_targets.fuzz
        ├── performance-result.json ← if selected_targets.performance
        ├── quality-gate-result.json ← always (primary mode)
        ├── summary.md            ← primary mode only
        ├── execution-manifest.yaml
        ├── known-product-issues.md   ← per-run snapshot (if present)
        └── raw/
            ├── api.log           ← fallback or CLI raw output
            ├── e2e.log
            ├── pytest-report.xml
            └── e2e-junit.xml
        ├── traces/
        ├── screenshots/
        └── videos/
```

## Execution Manifest

Always write an execution manifest that records which runner produced the result, so a fallback pass is never reported as a clean primary pass.

Paths:

```text
qa/changes/<change-id>/execution/runs/<batch-id>/execution-manifest.yaml
qa/changes/<change-id>/execution/execution-manifest.yaml   ← latest pointer
```

Structure:

```yaml
schema_version: "1.0"
change_id: <change-id>
batch_id: <YYYYMMDD-HHmmss>
selected_targets:
  api: true | false
  e2e: true | false
  fuzz: true | false
  performance: true | false
result_files:                    # CLI canonical map (paths relative to execution/)
  api: runs/<batch-id>/api-result.json
  e2e: runs/<batch-id>/e2e-result.json
  fuzz: runs/<batch-id>/fuzz-result.json
  performance: runs/<batch-id>/performance-result.json
  coverage: runs/<batch-id>/coverage-result.json
  summary: runs/<batch-id>/summary.md

# Skill extended format (optional augment on latest pointer only):
primary_runner:
  command: aws run --change <change-id>
  status: passed | failed | skipped
  exit_code: <int|null>
  result_files: []   # full paths to batch files actually written for selected_targets

fallback_runner:
  used: true | false
  reason: aws_cli_missing | aws_cli_invalid | primary_failed | result_files_missing | null
  command: <direct pytest command|null>
  status: passed | failed | skipped | not_used
  exit_code: <int|null>
  normalised_results_available: false   # always false in v1 fallback

selected_targets:
  api: true | false
  e2e: true | false
  fuzz: true | false
  performance: true | false

known_product_issues:
  present: true | false
  file: qa/changes/<change-id>/known-product-issues.md

final_status: PASS | PASS_WITH_WARNINGS | FAIL | SKIPPED
warnings:
  - <warning>
```

Manifest rule:

- If `fallback_runner.used == true` and the fallback passed, `final_status` **must** be `PASS_WITH_WARNINGS`, never `PASS`.

## Final Status Mapping

`final_status` must be one of: `PASS | PASS_WITH_WARNINGS | FAIL | SKIPPED`.

**PASS:**

- All selected test targets passed.
- No known product issues.
- No fallback runner used after a primary failure.

**PASS_WITH_WARNINGS:**

- Tests passed but `known-product-issues.md` exists.
- Primary runner failed/skipped but the fallback runner passed.
- A partial target was skipped with an explicit non-blocking reason.
- A coverage gap exists, i.e. `coverage-result.json.status == PASS_WITH_WARNINGS` (line/branch below threshold) **and** `coverage.gate_mode == warn` (default). When `gate_mode == block`, below-threshold coverage maps to **FAIL** instead.
- Coverage was not collected (`available == false`) — this is a warning, never a fail.

**FAIL:**

- Any selected target failed.
- The CLI failed without trustworthy result files.
- Required result files are missing.
- A known blocker should prevent release.

**SKIPPED:**

- No selected test targets.
- Codegen not done for the requested test type.
- Execution intentionally skipped with an explicit reason.

When known product issues exist, the result must be `PASS_WITH_WARNINGS`, never a clean `PASS`.

**Workflow-level note:** When `phases.execution.status == PASS_WITH_WARNINGS`, the orchestrator's final workflow status must be `completed_with_warnings`, not `completed`.

## Steps

1. Resolve `selected_targets` (see **Selected Targets Resolution**).
2. Run **AWS CLI Identity Check** (`aws --version` must identify Assurance Workflow Skills CLI).
3. If identity check passes, call `aws run --change <change-id>` in the terminal; otherwise skip to fallback per **Runner Mode**.
4. Wait for the command to complete (or complete fallback pytest for selected targets only).
5. Resolve `batch_id` (see **Batch ID Resolution**).
6. Read result files per **selected_targets** — do not fail on absent unselected target files.
7. If primary mode: read `execution/summary.md` (CLI-owned). If fallback: do not expect normalised result files.
8. Read `qa/changes/<change-id>/known-product-issues.md` (if present) and snapshot into execution folder.
9. Verify CLI-owned `summary.md` includes known-product-issues block if applicable — if missing, record warning in `execution-manifest.yaml`; do **not** rewrite `summary.md`.
10. Write `execution-manifest.yaml` (per-run + latest pointer) with `selected_targets`, primary/fallback runner, and `final_status`.
11. Present a brief summary to the user (final status, counts, fallback mode if used).
12. Update `workflow-state.yaml`: set `phases.execution.status`, `phases.execution.batch_id` (resolved, not guessed).
13. Do **not** generate `failure-analysis.json` — that is the job of `aws-inspect`.

## Known Product Issues During Execution

A passing test suite does not always mean the product has no issues.

If execution or test diagnostics reveal a real product bug that was worked around during codegen, record it in execution outputs.

Examples:

- A direct endpoint returns 500, but the test uses a list/search endpoint as workaround.
- A UI flow is skipped due to a known product issue.
- A backend bug is observed but not fixed in this workflow.

Codegen skills do **not** create the first acknowledgment of endpoint coverage gaps. The change-level record is created by human + reviewer workflow before codegen pass; codegen may append implementation notes only.

`aws-run` must read this file if present and snapshot it into execution:

```text
qa/changes/<change-id>/execution/runs/<batch-id>/known-product-issues.md   ← execution snapshot
qa/changes/<change-id>/execution/known-product-issues.md                   ← latest pointer
```

Path semantics:

- **Source of truth:** `qa/changes/<change-id>/known-product-issues.md`
- **Execution snapshot:** `qa/changes/<change-id>/execution/runs/<batch-id>/known-product-issues.md`

**summary.md boundary:**

- `execution/summary.md` is **CLI-owned**. The skill **must not** rewrite it.
- The CLI **should** include a known-product-issues status block when the source file exists:

```yaml
final_status: PASS_WITH_WARNINGS
known_product_issues:
  count: <N>
  source: qa/changes/<change-id>/known-product-issues.md
  snapshot: qa/changes/<change-id>/execution/runs/<batch-id>/known-product-issues.md
```

- The skill **verifies** this block after primary CLI run. If missing, record a warning in `execution-manifest.yaml` — do **not** patch `summary.md`.
- Optionally write skill-owned notes to `execution/run-summary-note.md` (fallback mode or verification gaps).

### Valid Execution Status Values

```text
PASS
PASS_WITH_WARNINGS
FAIL
SKIPPED
```

If known product issues exist, **do not** report the execution as `PASS`, `clean_pass`, `fully_passed`, or `no_risk` — use `PASS_WITH_WARNINGS`.

## Hard Rules

- **Never fabricate** PASS / FAIL / SKIPPED status or normalised result files.
- **Never fabricate coverage numbers.** Coverage comes from the CLI (`coverage-result.json`). Missing `pytest-cov` → coverage `SKIPPED` (warning), it must **not** cause `FAIL`.
- Coverage below threshold maps to `PASS_WITH_WARNINGS` when `coverage.gate_mode == warn` (default), or `FAIL` when `gate_mode == block`.
- Primary mode: CLI result files are the source of truth for normalised outputs; the skill does not synthesize them.
- Fallback mode: do **not** fabricate `api-result.json` or `e2e-result.json`; write manifest + raw logs only.
- Run **AWS CLI Identity Check** before `aws run` — do not invoke Amazon AWS CLI.
- Resolve `batch_id` from CLI output — never guess from wall clock alone.
- Require result files only for **selected_targets**; absent unselected target files is not a failure.
- If primary CLI fails to write expected result files (for selected targets), set `final_status = FAIL` or apply fallback per **Runner Mode**.
- Always write `execution-manifest.yaml` recording `selected_targets`, primary/fallback runner, and `final_status`.
- Fallback direct pytest runs **only selected targets**.
- Always attempt identity check + primary CLI first; direct pytest fallback only when `allow_direct_pytest_fallback: true` or user accepts risk.
- If primary cannot run (`aws_cli_missing`, `aws_cli_invalid`) and fallback is not allowed, `final_status` must be `FAIL`.
- If fallback was used and passed, `final_status` must be `PASS_WITH_WARNINGS`, never `PASS`.
- Do **not** rewrite CLI-owned `execution/summary.md` — verify only; warn in manifest if expected block missing.
- If the CLI returns failed, advise the user to run `aws report inspect --change <change-id>`.
- Do **not** invoke MCP as a substitute for the CLI.
- `aws-run` snapshots `known-product-issues.md` into `execution/`; it does not author the source-of-truth file.
- If `known-product-issues.md` exists, always set execution `final_status` to `PASS_WITH_WARNINGS`, never `PASS`.
- If `final_status == PASS_WITH_WARNINGS`, downstream workflow status must be `completed_with_warnings`, not `completed`.
