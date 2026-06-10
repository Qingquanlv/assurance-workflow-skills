---
name: aws-inspect
description: "AWS M5: Inspect execution results and classify test failures via `aws report inspect --change <change-id>`. Use when tests have failed and the user wants to understand why. Classifies failures into categories (locator, assertion, environment, etc.) and writes inspect/failure-analysis.json, failure-summary.md, and inspect/known-product-issues.md. Never classifies failures without the CLI."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.execution.status` is set (execution must have run).
3. Read `execution/execution-manifest.yaml`. If it is missing, stop and ask the user to re-run `aws-run`. Do not infer runner status from result files alone.
4. Check fallback / normalised result availability:
   - If `fallback_runner.used == true` and `fallback_runner.normalised_results_available == false`:
     - Primary CLI inspect **cannot** run.
     - Use fallback partial inspect **only if** allowed (see **Inspector Mode**).
     - Otherwise **STOP** and ask to re-run execution with valid Assurance Workflow Skills CLI.
5. Read result files based on `execution-manifest.yaml` `selected_targets` — **primary mode only**:
   - If `selected_targets.api == true`, require `execution/api-result.json`.
   - If `selected_targets.e2e == true`, require `execution/e2e-result.json`.
   - Do not require result files for targets that were not selected.
   - In fallback partial mode with no normalised results, skip this requirement and use raw logs / manifest / `run-summary-note.md` instead.
6. Read `execution/known-product-issues.md` if present (execution snapshot — do not overwrite).
7. Run **AWS CLI Identity Check** before primary inspect (see below).
8. If any required input for the chosen inspect mode is missing, stop and report.
9. Use files as the sole source of truth.

**After completing work (primary mode — CLI succeeded):**

1. Verify CLI wrote `inspect/failure-analysis.json`. If missing, see **CLI Output Missing**.
2. Write optional pointers into `execution/` (for downstream consumers):
   - `qa/changes/<change-id>/execution/failure-analysis.json` (copy/pointer)
   - `qa/changes/<change-id>/execution/failure-summary.md` (copy/pointer)
3. Update `workflow-state.yaml`:
   - Set `phases.inspect.status = done`
   - Set `phases.inspect.inspect_mode = primary`
   - Set `phases.inspect.classification_performed = true`
   - Update `phases.execution.status` only under **Status Update Rules**
   - Append inspect-discovered issues to `phases.inspect.known_product_issues` (not change-level record unless promoted)

**After completing work (fallback partial mode):**

1. Write:
   - `qa/changes/<change-id>/inspect/failure-summary.md` (raw summary only)
   - `qa/changes/<change-id>/inspect/inspection-partial.json` (see **Fallback Partial Output**)
2. Do **not** write `inspect/failure-analysis.json`.
3. Update `workflow-state.yaml`:
   - Set `phases.inspect.status = partial`
   - Set `phases.inspect.inspect_mode = partial`
   - Set `phases.inspect.classification_performed = false`
   - Do **not** upgrade `phases.execution.status` (see **Status Update Rules**)

**After CLI failure (primary attempted, outputs missing):**

1. Write `qa/changes/<change-id>/inspect/inspection-error.json` or `inspect/inspection-error.md`
2. Set `phases.inspect.status = failed`
3. Do not classify manually

---

# Skill: aws-inspect

## Purpose

Inspect execution results and artifacts for a specific change, classify failures by category, and present a failure summary to the user.

## Skill vs CLI Boundary

**Primary mode:** The CLI (`aws report inspect`) is the only trusted classifier. The skill invokes the CLI and verifies `inspect/failure-analysis.json`.

**Fallback partial mode:** The skill may summarize raw artifacts but **must not** assign failure categories or write `failure-analysis.json`.

**Never:** Fabricate categories, overwrite `execution/known-product-issues.md` with inspect discoveries, or promote inspect findings to change-level records without explicit permission.

## AWS CLI Identity Check

This skill calls the **Assurance Workflow Skills CLI** (`aws`) — **not** the Amazon Web Services CLI.

Before running `aws report inspect --change <change-id>`, run:

```bash
aws --version
```

**Hard rule:** The output **must** identify the Assurance Workflow Skills CLI.

| Condition | Treatment |
|-----------|-----------|
| Command missing | `aws_cli_missing` |
| Output indicates Amazon AWS CLI, or does not identify Assurance Workflow Skills CLI | `aws_cli_invalid` |

In either case:

- Do **not** run `aws report inspect --change <change-id>`
- If fallback is allowed → use partial inspect mode (see **Inspector Mode**)
- If fallback is not allowed → **STOP** and report

## Inspector Mode

**Primary mode:**

1. Run **AWS CLI Identity Check**.
2. Verify `execution-manifest.yaml` does **not** require fallback-only inspect (see Context Contract step 4).
3. If checks pass, attempt `aws report inspect --change <change-id>`.

**Fallback mode (partial inspect):**

Allowed **only when**:

- `allow_direct_inspect_fallback: true` in `.aws/config.yaml`, or
- the user explicitly accepts the fallback risk.

Fallback reasons (record in `inspection-partial.json`):

```text
aws_cli_missing | aws_cli_invalid | cli_failed | analysis_files_missing | normalised_results_unavailable
```

Fallback rules:

- May summarize existing result files, raw logs, or manifest metadata.
- **Must not** assign failure categories — classification is the CLI's exclusive responsibility.
- **Must not** write `inspect/failure-analysis.json`.
- **Must** write `inspect/inspection-partial.json` and `inspect/failure-summary.md`.
- Set `phases.inspect.status = partial`, `inspect_mode = partial`, `classification_performed = false`.
- Do **not** treat partial inspect as complete diagnosis or healing input.

## Fallback Partial Output

**Fallback mode must NOT write:**

- `inspect/failure-analysis.json`

**Fallback mode MAY write:**

- `inspect/failure-summary.md`
- `inspect/inspection-partial.json`

`inspection-partial.json` structure (no comments in actual file):

```json
{
  "schema_version": "1.0",
  "change_id": "<change-id>",
  "batch_id": "<batch-id>",
  "inspect_mode": "partial",
  "classification_performed": false,
  "reason": "aws_cli_missing",
  "selected_targets": {
    "api": true,
    "e2e": false
  },
  "raw_result_summary": {},
  "next_action": "Fix AWS CLI or rerun with CLI inspect"
}
```

Valid `reason` values: `aws_cli_missing | aws_cli_invalid | cli_failed | analysis_files_missing | normalised_results_unavailable`

## CLI Invocation

Run **AWS CLI Identity Check** before primary mode.

If identity check passes and primary inspect is allowed:

```bash
aws report inspect --change <change-id>
```

Example:

```bash
aws report inspect --change REQ-002-user-logout
```

If identity check fails or normalised results unavailable, apply **Inspector Mode** fallback rules — do not invoke Amazon AWS CLI.

MCP is optional and must not replace the CLI execution chain.

## What the CLI Does

`aws report inspect` reads execution artifacts and classifies each failure:

1. Reads `execution/execution-manifest.yaml` to determine selected targets and runner context.
2. Reads `execution/api-result.json` and/or `execution/e2e-result.json` (per selected targets).
3. Reads raw logs, traces, screenshots, and videos.
4. Reads associated `case.yaml` and test source files.
5. Classifies each failure into a defined category.
6. Writes `failure-analysis.json`, `failure-summary.md`, and (if applicable) `inspect/known-product-issues.md`.

## failure-analysis.json Schema

Primary inspect output written by the CLI (skill verifies; does not fabricate). Minimal top-level structure.

`inspect_mode` enum (JSON and `workflow-state.yaml`): `primary | partial`

```json
{
  "schema_version": "1.0",
  "change_id": "<change-id>",
  "batch_id": "<batch-id>",
  "source_manifest": "qa/changes/<change-id>/execution/execution-manifest.yaml",
  "inspect_mode": "primary",
  "classification_performed": true,
  "inspection_status": "completed",
  "final_status": "FAIL",
  "failures": [
    {
      "id": "FAIL-001",
      "target": "api",
      "test": "test_menu_get_returns_200",
      "category": "assertion_failure",
      "severity": "medium",
      "evidence": {
        "log": "execution/runs/<batch-id>/raw/api.log",
        "junit_xml": "execution/runs/<batch-id>/raw/pytest-report.xml"
      },
      "fix_proposal_eligible": false,
      "recommended_next_action": "human_review"
    },
    {
      "id": "FAIL-002",
      "target": "e2e",
      "test": "test_checkout_flow",
      "category": "locator_failure",
      "severity": "medium",
      "evidence": {
        "log": "execution/runs/<batch-id>/raw/e2e.log",
        "trace": "execution/runs/<batch-id>/traces/...",
        "screenshot": "execution/runs/<batch-id>/screenshots/..."
      },
      "fix_proposal_eligible": true,
      "recommended_next_action": "run_fix_proposal"
    }
  ],
  "known_product_issues": [],
  "coverage_gaps": []
}
```

Failure `category` enum:

```text
locator_failure | wait_strategy_failure | test_code_error | test_data_failure | environment_failure | assertion_failure | business_logic_failure | case_semantic_failure | known_product_issue | coverage_gap | unknown
```

Failure `recommended_next_action` enum:

```text
run_fix_proposal | human_review | fix_product | fix_environment | rerun
```

Known issue entry in `known_product_issues[]` (within failure-analysis.json):

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
  "requires_promotion": true,
  "next_action": "fix backend serialization in get_menu"
}
```

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

Supported inspect analysis categories:

```text
product_bug | known_product_issue | coverage_gap | test_bug | test_data_issue | environment_issue | unknown
```

Examples:

- Endpoint returns 500 due to backend serialization error.
- Test validates behavior through an alternate endpoint because the direct endpoint is broken.
- Product behavior is incorrect but not blocking the remaining test suite.

### Directory Semantics (Known Product Issues)

| Path | Role |
|------|------|
| `qa/changes/<change-id>/known-product-issues.md` | **Change-level** source of truth (human/reviewer before codegen; codegen append-only) |
| `execution/known-product-issues.md` | **Execution snapshot** copied from change-level record by `aws-run` |
| `inspect/known-product-issues.md` | **Inspect analysis output** for inspect-discovered or confirmed issues |

Hard rules:

- `execution/known-product-issues.md` is the execution snapshot from change-level known issues — **do not overwrite** with inspect-discovered issues.
- `inspect/known-product-issues.md` holds inspect analysis output; new findings wait for **promotion** — do not replace execution snapshot.
- Inspect must **not** directly modify `qa/changes/<change-id>/known-product-issues.md` unless promotion is allowed (see below).

### Known Product Issue Promotion Rule

`aws-inspect` may write:

- `qa/changes/<change-id>/inspect/known-product-issues.md`

It must **not** directly modify:

- `qa/changes/<change-id>/known-product-issues.md`

unless:

- `.aws/config.yaml` has `allow_inspect_promote_known_issues: true`, or
- the user explicitly confirms promotion.

If promotion is **not** allowed:

- Mark the issue as `requires_promotion: true` in `failure-analysis.json` / `inspect/known-product-issues.md`
- Set or keep execution status as `PASS_WITH_WARNINGS` if evidence supports it
- Ask human/orchestrator to promote the inspect finding into the change-level record

If known product issues exist, the workflow final summary must **not** say `no risk`, `fully clean`, or `clean pass`.

## Output Files (read after CLI completes)

```
qa/changes/<change-id>/inspect/           ← primary analysis outputs (source of truth)
├── failure-analysis.json                ← primary mode only (CLI-written)
├── failure-summary.md
├── known-product-issues.md              ← inspect analysis (if issues found; not change-level)
├── inspection-partial.json              ← fallback partial mode only
└── inspection-error.json              ← primary CLI failed / outputs missing

qa/changes/<change-id>/execution/         ← optional pointers/copies for downstream consumers
├── failure-analysis.json                ← pointer/copy (primary mode only)
└── failure-summary.md                   ← pointer/copy
```

## CLI Output Missing

If the CLI completes but required primary output is missing (`inspect/failure-analysis.json`):

- Do **not** classify manually
- Set `phases.inspect.status = failed`
- Write `inspect/inspection-error.json` or `inspect/inspection-error.md` with:
  - `reason: analysis_files_missing`
  - `batch_id` from manifest
  - recommendation to rerun `aws report inspect --change <change-id>`
- Do **not** write `failure-analysis.json`

## Steps

1. Confirm execution has run (`phases.execution.status` set).
2. Read `execution/execution-manifest.yaml` — stop if missing.
3. Check fallback / normalised result rules (Context Contract step 4).
4. Run **AWS CLI Identity Check**.
5. If primary inspect allowed: call `aws report inspect --change <change-id>`; wait for completion.
6. If primary not allowed: apply fallback partial inspect if permitted; otherwise STOP.
7. Verify outputs per mode (primary → `failure-analysis.json`; partial → `inspection-partial.json`).
8. Read `inspect/failure-analysis.json` (primary) or `inspect/inspection-partial.json` (partial).
9. Read `inspect/failure-summary.md`.
10. Read `inspect/known-product-issues.md` if present — do **not** overwrite `execution/known-product-issues.md`.
11. Present summary to user (category breakdown in primary mode; raw summary in partial mode).
12. Update `workflow-state.yaml` per mode (see Context Contract **After completing work**).
13. Do **not** generate fix proposals in this skill — eligible failures are consumed by downstream healing skills.

## Status Update Rules

### Primary mode

`aws-inspect` may only update `phases.execution.status` under these conditions:

- `PASS` → `PASS_WITH_WARNINGS`: allowed when `known_product_issue` or `coverage_gap` is confirmed in `failure-analysis.json` and documented in `inspect/known-product-issues.md` (promotion to change-level record still requires **Known Product Issue Promotion Rule**).
- `FAIL` → `FAIL`: never change a FAIL status — inspection clarifies category but cannot clear it.
- Any status → `PASS`: **forbidden**.
- `PASS_WITH_WARNINGS` → `PASS`: **forbidden**.
- Reclassifying a failure as `known_product_issue` to avoid `FAIL`: **forbidden** unless evidence is in `failure-analysis.json` and inspect output — not by overwriting execution snapshot alone.

Set `phases.inspect.status = done`, `inspect_mode = primary`, `classification_performed = true`.

### Fallback partial mode

- Do **not** change `phases.execution.status` except never upgrade it.
- Set `phases.inspect.status = partial`
- Set `phases.inspect.inspect_mode = partial`
- Set `phases.inspect.classification_performed = false`
- Do **not** set `phases.inspect.status = done` — partial inspect is not complete diagnosis.

Valid `phases.execution.status` values: `PASS | PASS_WITH_WARNINGS | FAIL | SKIPPED`.

If `final_status == PASS_WITH_WARNINGS`, downstream workflow status must be `completed_with_warnings`, not `completed`.

## Hard Rules

- **Never classify failures yourself** in primary mode — the CLI is the only trusted classifier.
- **Never fabricate** `failure-analysis.json` or category assignments.
- Run **AWS CLI Identity Check** before `aws report inspect` — do not invoke Amazon AWS CLI.
- If CLI completes but `inspect/failure-analysis.json` is missing, write `inspection-error.*` and set `phases.inspect.status = failed` — do not guess.
- Do **not** invoke MCP as a substitute for the CLI.
- Always read `execution/execution-manifest.yaml` before inspecting.
- If `fallback_runner.used == true` and `normalised_results_available == false`, primary inspect cannot run — use partial fallback or STOP.
- Only require normalised result files for selected targets in **primary** mode.
- Do **not** overwrite `execution/known-product-issues.md` with inspect discoveries.
- Do **not** modify change-level `known-product-issues.md` without promotion permission.
- Environment failures must **not** enter a Fix Proposal pipeline.
- `known_product_issue` and `coverage_gap` must **not** enter Fix Proposal — require product fix.
- If known product issues exist, never report overall result as `no risk`, `clean`, or `PASS` — use `PASS_WITH_WARNINGS`.
- In fallback partial mode: no `failure-analysis.json`, no categories, `phases.inspect.status = partial`.

---

## Inspect Role in Healing

`aws-inspect` is the **diagnostic** stage of healing — not the repair stage.

It may:

- Classify failures into categories
- Collect limited evidence (logs, traces, screenshots)
- Determine whether failures have `fix_proposal_eligible == true`
- Write `inspect/failure-analysis.json`
- Write `inspect/failure-summary.md`
- Recommend that Phase 10 (`aws-fix-proposal`) be invoked

It **MUST NOT**:

- Modify test files (`tests/`)
- Modify fixtures
- Modify product code (`app/`, `web/`, `src/`)
- Apply any fix
- Execute tests as verification (diagnostic probes are not reruns — see **Diagnostic Probe Policy**)
- Write `failure-analysis.json` in fallback/partial mode

The repair pipeline is: `aws-fix-proposal` → `aws-api-codegen-fixer` / `aws-e2e-codegen-fixer` → `aws-run` → `aws-inspect` (re-inspect).

---

## Extended failure-analysis Failure Fields

Each failure in `failure-analysis.json.failures[]` written by the CLI (primary mode) should include — and the skill must verify these fields are present when reading for downstream healing:

```json
{
  "failure_id": "FAIL-001",
  "case_id": "CASE-001",
  "target": "api|e2e",
  "category": "<category>",
  "severity": "low|medium|high|critical",
  "summary": "Human-readable one-line description of the failure",
  "evidence": [],
  "in_current_change_scope": true,
  "requires_test_code_change": false,
  "requires_product_change": false,
  "fix_proposal_eligible": false,
  "recommended_next_action": "run_fix_proposal|human_review|fix_product|fix_environment|rerun"
}
```

If the CLI writes these fields, the skill must preserve them. If the CLI does not write them, the skill must **not** fabricate them — leave missing fields absent rather than guessing.

---

## Fix Proposal Eligibility Classification

These rules define `fix_proposal_eligible` for each category (written by the CLI; verified by this skill):

```text
locator_failure:
  fix_proposal_eligible: true
  requires_test_code_change: true
  requires_product_change: false

wait_strategy_failure:
  fix_proposal_eligible: true
  requires_test_code_change: true
  requires_product_change: false

test_code_error:
  fix_proposal_eligible: true
  requires_test_code_change: true
  requires_product_change: false

test_data_failure:
  fix_proposal_eligible: true   # only if test data generation can be fixed without changing product code or expected assertions
  requires_test_code_change: true
  requires_product_change: false (when eligible)
  NOTE: if product change is required → fix_proposal_eligible: false

environment_failure:
  fix_proposal_eligible: false
  requires_test_code_change: false
  requires_product_change: false
  recommended_next_action: fix_environment

assertion_failure:
  fix_proposal_eligible: false
  requires_test_code_change: false
  requires_product_change: false (may indicate product change needed — investigate)
  recommended_next_action: human_review

business_logic_failure:
  fix_proposal_eligible: false
  requires_test_code_change: false
  requires_product_change: true
  recommended_next_action: fix_product

known_product_issue:
  fix_proposal_eligible: false
  requires_product_change: true
  recommended_next_action: fix_product

coverage_gap:
  fix_proposal_eligible: false
  recommended_next_action: separate_change_required

product_bug:
  fix_proposal_eligible: false
  requires_product_change: true
  recommended_next_action: fix_product

unrelated_existing_failure:
  fix_proposal_eligible: false
  in_current_change_scope: false
  recommended_next_action: manual_investigation

unknown:
  fix_proposal_eligible: false
  recommended_next_action: manual_investigation
```

**Hard rule:** `aws-inspect` must **not** override the CLI's `fix_proposal_eligible` assignment. If the CLI writes `fix_proposal_eligible: false` for a `locator_failure`, do not change it — report the discrepancy for human review.

---

## Diagnostic Probe Policy

`aws-inspect` may run a limited number of targeted probes to gather evidence for classification.

**Probe limits:**

- At most **1 diagnostic probe per failure category** per inspect run
- At most **3 diagnostic probes total** per inspect run

**What counts as a probe:**

- Running a single targeted test or assertion to gather output/trace
- Reading a specific log entry matching a known failure pattern
- Checking a route or endpoint directly to confirm a product-level behavior

**What does NOT count as a probe:**

- Running `aws run --change <change-id>` (that is a rerun, not a probe)
- Reading existing log/trace files already present in `execution/`

**Recording probes:**

All probes must be recorded in:

```text
qa/changes/<change-id>/inspect/diagnostic-probes.json
```

```json
{
  "schema_version": "1.0",
  "change_id": "<change-id>",
  "batch_id": "<batch-id>",
  "probes": [
    {
      "probe_id": "PROBE-001",
      "category": "locator_failure",
      "failure_id": "FAIL-002",
      "command": "...",
      "purpose": "Confirm selector .product-card is absent in current DOM",
      "result": "confirmed"
    }
  ]
}
```

**Probes must NOT:**

- Update `execution/execution-manifest.yaml`
- Update `phases.execution.status`
- Be reported as reruns
- Count toward `max_healing_attempts`

---

## No File Modification

`aws-inspect` **MUST NOT** modify files outside its designated output directories.

**Allowed output paths:**

```text
qa/changes/<change-id>/inspect/**
qa/changes/<change-id>/execution/failure-analysis.json   (optional pointer/copy, primary mode only)
qa/changes/<change-id>/execution/failure-summary.md      (optional pointer/copy, primary mode only)
qa/changes/<change-id>/inspect/diagnostic-probes.json    (probe record)
```

**Forbidden during inspect:**

```text
tests/**
app/**
web/**
src/**
.aws/**
qa/changes/<change-id>/cases/**
qa/changes/<change-id>/plans/**
qa/changes/<change-id>/review/**
qa/changes/<change-id>/healing/**
qa/changes/<change-id>/execution/execution-manifest.yaml   (must not update)
qa/changes/<change-id>/execution/known-product-issues.md   (must not overwrite execution snapshot)
```

If the orchestrator (`aws-workflow`) detects that `aws-inspect` modified any forbidden path during Phase 9 or Phase 13, it must:

1. Set `phases.inspect.status = failed`
2. Set `workflow_status = stopped`
3. Stop the workflow immediately
