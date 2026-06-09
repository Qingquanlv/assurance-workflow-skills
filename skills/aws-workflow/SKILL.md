---
name: aws-workflow
description: "Run the full AWS QA workflow inline in the primary agent — loads each phase skill (case-design, case-reviewer, api-plan, e2e-plan, plan-reviewer, api-codegen, e2e-codegen, aws-run, aws-inspect) sequentially in the same context. No subagent skill loading. Phase state tracked via workflow-state.yaml."
---

# AWS Workflow

## Purpose

This is the **orchestrator entry skill** for running the full AWS QA workflow inside an OpenCode client.

It is not a case design, review, or codegen skill. It coordinates the entire workflow by:

- Loading other AWS skills phase by phase
- Loading each phase skill inline in the primary agent (no subagent skill loading)
- Verifying phase output files before advancing
- Reading review JSON to make gate decisions
- Enforcing retry policy for fix/review loops
- Applying watchdog policy for any document-driven subagents (idle/total timeout, foreground retry once)
- Stopping on `reject`, missing files, `human_review_required`, or exceeded retries
- Producing a structured final summary

Do not perform detailed case design, review, fix, or codegen work directly inside this skill — load the appropriate phase skill and execute it inline.

---

## Execution Mode

This workflow uses **inline skill orchestration**.

Do not rely on OpenCode subagents or tasks to inherit loaded skills or conversation context. OpenCode task agents do not reliably resolve project skills when invoked as subagents. This causes "Skills not found" failures in any phase delegated to a background task.

The orchestrator must:

1. Load each phase skill directly in the **primary agent**.
2. Execute the phase inline (in the same agent context as the orchestrator).
3. Persist all phase outputs to `qa/changes/<change-id>/` before advancing.
4. Before entering the next phase, **re-read the required files from disk**.
5. Treat `qa/changes/<change-id>/workflow-state.yaml` and phase output files as the **only source of truth** between phases.
6. Never assume another skill shares in-memory context from a previous phase.

### Required Pattern

```text
primary agent
  → load aws-workflow
  → load aws-case-design        ← in primary agent
  → execute phase inline
  → write files to disk
  → update workflow-state.yaml
  → load aws-case-reviewer      ← in primary agent
  → read files from disk
  → execute phase inline
  → ...
```

### Forbidden Pattern

```text
aws-workflow
  → task / subagent
      → load skill              ← FORBIDDEN
```

If parallel execution is genuinely needed, only **document-driven subagents** are permitted:

```text
subagent receives plan.md as input
subagent executes the plan directly
subagent MUST NOT be asked to load a skill
```

This restriction remains in effect until OpenCode explicitly supports reliable subagent skill inheritance.

---

## Invocation

Users invoke this workflow in OpenCode by addressing `@aws-orchestrator`:

```text
@aws-orchestrator

use skill aws-workflow

Requirement:
<describe what to test>

Run mode:
full

Max case fix attempts:
2

Max plan fix attempts:
2

Force continue:
false
```

---

## Runtime Parameters

| Parameter | Default | Description |
|---|---|---|
| `run_mode` | `full` | Which phases to execute |
| `test_types` | `api,e2e` | Which test types to run: `api`, `e2e`, or `api,e2e` |
| `max_case_fix_attempts` | `2` | Max times to run aws-case-fixer before giving up |
| `max_plan_fix_attempts` | `2` | Max times to run aws-plan-fixer before giving up |
| `force_continue` | `false` | Whether to bypass human_review / high-risk stops |
| `run_dashboard` | `false` | Whether to launch aws-dashboard after completion |
| `run_tests` | `true` | Whether to execute tests via aws-run after codegen |
| `test_command` | `aws run --change <change-id>` | The test execution command (fallback: `uv run pytest tests/e2e/ -v --headed`) |
| `e2e_framework` | `python-playwright` | E2E framework: `python-playwright` only (TS Playwright not supported) |
| `max_idle_minutes` | `5` | Background subagent idle timeout before cancel |
| `max_total_minutes_api_plan` | `10` | Hard cap for background `api_plan` subagent |
| `max_total_minutes_e2e_plan` | `10` | Hard cap for background `e2e_plan` subagent |
| `max_total_minutes_api_codegen` | `10` | Hard cap for background `api_codegen` subagent |
| `max_total_minutes_e2e_codegen` | `10` | Hard cap for background `e2e_codegen` subagent |
| `retry_foreground_once` | `true` | Retry cancelled/timed-out background phase once in foreground |

Users may override any parameter in the OpenCode message. Parameters not provided use the defaults above.

---

## Supported Run Modes

| Mode | Phases Executed |
|---|---|
| `full` | All phases from case design to test execution (API + E2E) |
| `case-only` | Case design + case review (+ fix if needed) |
| `api-only` | API plan + plan review (+ fix if needed) + API codegen + run |
| `e2e-only` | E2E plan + plan review (+ fix if needed) + E2E codegen + run |
| `plan-only` | API + E2E plan + plan review (+ fix if needed). Requires existing case files. |
| `codegen-only` | API + E2E codegen only. Requires existing plan files. |
| `review-case` | Case review + fix only. Requires existing case files. |
| `review-plan` | Plan review + fix only. Requires existing plan files. |

Default: `full`.

**Important — `aws-case-design` is only invoked in `full` and `case-only` modes.**

For `api-only`, `e2e-only`, `plan-only`, `codegen-only`, `review-case`, and `review-plan`:

- Do **not** invoke `aws-case-design`.
- Require a valid `change_id` from the user before starting.
- Validate that the required input files for the selected mode already exist before proceeding.
- If required files are missing, **stop** and tell the user which files are needed.

| Mode | Required files before starting |
|---|---|
| `api-only` | `qa/changes/<change-id>/cases/**/*.yaml` |
| `e2e-only` | `qa/changes/<change-id>/cases/**/*.yaml` |
| `plan-only` | `qa/changes/<change-id>/cases/**/*.yaml` |
| `codegen-only` | `qa/changes/<change-id>/plans/api-plan.md` or `e2e-plan.md` (per test_types) |
| `review-case` | `qa/changes/<change-id>/cases/**/*.yaml` |
| `review-plan` | `qa/changes/<change-id>/plans/api-plan.md` or `e2e-plan.md` (per test_types) |

---

## Phase 0 — Skill Registry Check

Before starting any workflow phase, verify all required skills can be loaded in the **primary agent**.

```yaml
required_skills:
  - aws-case-design
  - aws-case-reviewer
  - aws-case-fixer
  - aws-api-plan
  - aws-e2e-plan
  - aws-api-plan-reviewer
  - aws-plan-reviewer
  - aws-api-plan-fixer
  - aws-plan-fixer
  - aws-api-codegen
  - aws-e2e-codegen
  - aws-run
  - aws-inspect
  - aws-archive
```

If any skill fails to load:

- **STOP** immediately.
- Report the missing skill name.
- Do not start case design.
- Do **not** check subagent skill resolution — this workflow does not use subagent skill loading.

---

## Inline Skill Routing

All phases load skills and execute **in the primary agent**. No subagents or tasks are used.

| Phase | Skill to Load |
|---|---|
| Phase 0: Registry Check | (verify all required skills above) |
| Phase 1: Case Design | `aws-case-design` |
| Phase 2: Case Review | `aws-case-reviewer` |
| Phase 3: Case Fix | `aws-case-fixer` |
| Phase 4A: API Plan | `aws-api-plan` |
| Phase 4B: E2E Plan | `aws-e2e-plan` |
| Phase 5A: API Plan Review | `aws-api-plan-reviewer` |
| Phase 5B: E2E Plan Review | `aws-plan-reviewer` |
| Phase 6A: API Plan Fix | `aws-api-plan-fixer` |
| Phase 6B: E2E Plan Fix | `aws-plan-fixer` |
| Phase 7A: API Codegen | `aws-api-codegen` |
| Phase 7B: E2E Codegen | `aws-e2e-codegen` |
| Phase 8: Execution | `aws-run` |
| Phase 9: Inspect | `aws-inspect` |
| Phase 10: Archive | `aws-archive` |
| Phase 9 (optional): Dashboard | `aws-dashboard` (only when `run_dashboard = true`) |

After each phase, **update `workflow-state.yaml`** before loading the next skill.
---

## workflow-state.yaml

Path: `qa/changes/<change-id>/workflow-state.yaml`

This file is the **canonical cross-phase state source**. Every phase must read it at entry and update it at exit.

```yaml
schema_version: "1.0"
change_id: <change-id>
module: <module>

execution_mode: inline
subagent_skill_inheritance: disabled

phases:
  skill_registry_check:
    status: pass | fail
    checked_skills:
      - aws-case-design
      - aws-case-reviewer
      - aws-case-fixer
      - aws-api-plan
      - aws-e2e-plan
      - aws-api-plan-reviewer
      - aws-plan-reviewer
      - aws-api-plan-fixer
      - aws-plan-fixer
      - aws-api-codegen
      - aws-e2e-codegen
      - aws-run
      - aws-inspect
      - aws-archive

  case_design:
    status: pending | done | failed
    outputs:
      - .qa.yaml
      - proposal.md
      - cases/<module>/case.yaml

  case_review:
    status: pending | pass | needs_fix | needs_human_review | reject
    gate_file: review/case-review.json

  api_plan:
    status: pending | done | failed
    outputs:
      - plans/api-plan.md
      - plans/api-test-data-plan.md
      - plans/api-codegen-plan.md

  e2e_plan:
    status: pending | done | failed
    outputs:
      - plans/e2e-plan.md
      - plans/e2e-test-data-plan.md
      - plans/e2e-codegen-plan.md

  api_plan_review:
    status: pending | pass | needs_fix | needs_human_review | reject
    gate_file: review/api-plan-review.json

  e2e_plan_review:
    status: pending | pass | needs_fix | needs_human_review | reject
    gate_file: review/plan-review.json

  api_codegen:
    status: pending | done | failed
    generated_tests:
      framework: pytest
      language: python
      files: []

  e2e_codegen:
    status: pending | done | failed
    generated_tests:
      framework: pytest-playwright
      language: python
      files: []

  execution:
    status: pending | passed | passed_with_known_issues | failed | skipped
    batch_id: <YYYYMMDD-HHmmss>

  inspect:
    status: pending | done | failed
    outputs:
      - execution/failure-analysis.json
      - execution/failure-summary.md
      - inspect/known-product-issues.md (if known issues found)
      - inspect/failure-analysis.json (if known issues found)

  archive:
    status: pending | archived | archived_with_known_issues | skipped

gates:
  data_knowledge:
    status: present | missing
    decision: pass | force_continue | stop

known_product_issues: []

agent_warnings:
  - id: OPENCODE-SKILL-RESOLUTION-001
    severity: medium
    title: OpenCode subagent skill inheritance is disabled
    impact:
      - no skill-based background subagent execution
      - workflow phases run inline
    workaround:
      - use file-based phase contracts
      - use document-driven subagents only if parallelism is needed
    status: acknowledged
```

---

## Phase Contracts

### Phase 1 — Case Design

```yaml
inputs:
  - user requirement text
  - qa/cases/** (existing cases)
  - source code (backend/frontend)
outputs:
  - qa/changes/<change-id>/.qa.yaml
  - qa/changes/<change-id>/proposal.md
  - qa/changes/<change-id>/cases/<module>/case.yaml
  - qa/changes/<change-id>/workflow-state.yaml (create/update)
```

### Phase 2 — Case Review

```yaml
inputs:
  - workflow-state.yaml
  - .qa.yaml
  - proposal.md
  - cases/<module>/case.yaml
outputs:
  - review/case-review.json
  - review/case-review-summary.md
  - workflow-state.yaml (updated)
gate: decision == "pass"
```

### Phase 4A — API Plan

```yaml
inputs:
  - workflow-state.yaml
  - proposal.md
  - cases/<module>/case.yaml
  - .aws/config.yaml
  - .aws/data-knowledge.yaml (or plans/data-knowledge.proposal.yaml)
  - backend source files
outputs:
  - plans/api-plan.md
  - plans/api-test-data-plan.md
  - plans/api-codegen-plan.md
  - plans/m3-review-summary.md
  - workflow-state.yaml (updated)
```

### Phase 4B — E2E Plan

```yaml
inputs:
  - workflow-state.yaml
  - proposal.md
  - cases/<module>/case.yaml
  - .aws/config.yaml
  - .aws/data-knowledge.yaml (or plans/data-knowledge.proposal.yaml)
  - frontend source files
outputs:
  - plans/e2e-plan.md
  - plans/e2e-test-data-plan.md
  - plans/e2e-codegen-plan.md
  - plans/m4-review-summary.md
  - workflow-state.yaml (updated)
```

### Phase 5A — API Plan Review

```yaml
inputs:
  - workflow-state.yaml
  - plans/api-plan.md
  - plans/api-test-data-plan.md
  - plans/api-codegen-plan.md
outputs:
  - review/api-plan-review.json
  - review/api-plan-review-summary.md
  - workflow-state.yaml (updated)
gate:
  - decision == "pass"
  - codegen_readiness in ["ready", "ready_with_warnings"]
```

### Phase 5B — E2E Plan Review

```yaml
inputs:
  - workflow-state.yaml
  - plans/e2e-plan.md
  - plans/e2e-test-data-plan.md
  - plans/e2e-codegen-plan.md
outputs:
  - review/plan-review.json
  - review/plan-review-summary.md
  - workflow-state.yaml (updated)
gate:
  - decision == "pass"
  - codegen_readiness in ["ready", "ready_with_warnings"]
```

### Phase 7A — API Codegen

```yaml
inputs:
  - workflow-state.yaml
  - plans/api-plan.md
  - plans/api-test-data-plan.md
  - plans/api-codegen-plan.md
  - review/api-plan-review.json  # must be present and decision==pass
outputs:
  - tests/api/test_<module>_api.py
  - tests/api/helpers/<module>_api.py
  - tests/api/conftest.py (append only)
  - workflow-state.yaml (updated)
```

### Phase 7B — E2E Codegen

```yaml
inputs:
  - workflow-state.yaml
  - plans/e2e-plan.md
  - plans/e2e-test-data-plan.md
  - plans/e2e-codegen-plan.md
  - review/plan-review.json  # must be present and decision==pass
outputs:
  - tests/e2e/test_<module>_e2e.py
  - tests/e2e/scripts/<module>_data_setup.py
  - tests/e2e/conftest.py (append only)
  - workflow-state.yaml (updated)
```

### Phase 8 — Execution

```yaml
inputs:
  - workflow-state.yaml
  - generated test files (from phases 7A/7B)
  - .aws/config.yaml
outputs:
  - execution/runs/<batch-id>/api-result.json
  - execution/runs/<batch-id>/e2e-result.json
  - execution/runs/<batch-id>/summary.md
  - execution/api-result.json  (latest pointer)
  - execution/e2e-result.json  (latest pointer)
  - execution/summary.md       (latest pointer)
  - execution/known-product-issues.md (if codegen wrote one)
  - workflow-state.yaml (updated)
```

### Phase 9 — Inspect / Final Summary

```yaml
inputs:
  - workflow-state.yaml
  - execution/api-result.json
  - execution/e2e-result.json
  - execution/known-product-issues.md (if present)
outputs:
  - execution/failure-analysis.json (if failures)
  - execution/failure-summary.md (if failures)
  - inspect/known-product-issues.md (if known product issues found)
  - inspect/failure-analysis.json (if known product issues found)
  - human-readable final report
  - workflow-state.yaml (updated)
```

### Phase 10 — Archive

```yaml
inputs:
  - workflow-state.yaml
  - review/case-review.json (decision == "pass")
  - review/api-plan-review.json (if api tested)
  - review/plan-review.json (if e2e tested)
  - execution/api-result.json
  - execution/e2e-result.json
  - execution/summary.md
  - execution/known-product-issues.md (if present)
outputs:
  - qa/cases/<module>/case.yaml (merged)
  - qa/archive/<change-id>/  (all process artifacts copied)
  - workflow-state.yaml (updated: phases.archive.status)
gate: all applicable review JSON files have decision == "pass"
```

---

## Background Subagent Watchdog Policy

When this workflow dispatches any **background** subagent, it must apply watchdog control.

Foreground subagent dispatch (orchestrator waits for completion inline) does not require idle cancellation, but still respects per-phase `max_total_minutes` if configured.

### Default Config

```yaml
max_idle_minutes: 5
max_total_minutes:
  api_plan: 10
  e2e_plan: 10
  api_codegen: 10
  e2e_codegen: 10
retry_foreground_once: true
```

### Phases Under Watchdog

| Phase key | Subagent | Watchdog applies when dispatched in background |
|---|---|---|
| `api_plan` | `aws-api-plan` | yes |
| `e2e_plan` | `aws-e2e-plan` | yes |
| `api_codegen` | `aws-api-codegen` | yes |
| `e2e_codegen` | `aws-e2e-codegen` | yes |

Other phases (review, fix, run, inspect, archive) are not background-dispatched by default. If dispatched in background, apply the same idle/total timeout rules using the closest phase key or `max_idle_minutes` only.

### What Counts as Visible Progress

Treat any of the following as progress (resets idle timer):

- New or updated expected output file for the phase
- New review JSON or summary markdown written
- Subagent status message indicating active work (reading, writing, planning, generating)
- Terminal command started with relevant output

No visible progress for `max_idle_minutes` → idle timeout.

Total elapsed time exceeding phase `max_total_minutes` → total timeout (same handling as idle timeout).

### Behavior

1. If a background subagent has **no visible progress** for `max_idle_minutes`, **cancel** it.
2. If total elapsed time exceeds the phase `max_total_minutes`, **cancel** it.
3. If `retry_foreground_once == true`, **retry the same phase in foreground once** (orchestrator loads the skill directly or invokes subagent synchronously).
4. If the foreground retry **fails** (idle timeout, total timeout, unrecoverable error, or required outputs still missing), **stop the workflow**.
5. Record every watchdog incident in workflow state:

```yaml
agent_warnings:
  - phase: api_plan | e2e_plan | api_codegen | e2e_codegen
    issue: background subagent idle timeout | background subagent total timeout
    action: cancelled and retried foreground
    retry_result: passed | failed
```

Append to `agent_warnings` — never overwrite prior incidents.

### Foreground Retry Rules

- Foreground retry is **one attempt only** per phase per workflow run.
- Foreground retry must produce the **same expected output files** as a normal subagent run.
- Foreground retry does **not** bypass review JSON gates.
- If foreground retry passes, continue the workflow from the next gate check for that phase.
- If foreground retry fails, stop and report `Stop reason: background subagent watchdog — foreground retry failed for <phase>`.

### Workflow State

Maintain `agent_warnings` in `workflow-state.yaml` throughout the run. The final summary **must** include it (see Final Response Format). The `OPENCODE-SKILL-RESOLUTION-001` warning must always be present since this workflow runs inline.

---

## Full Workflow (run_mode = full)

All phases execute **inline in the primary agent**. No subagents or tasks are used.

```
Phase 0 — Skill Registry Check
  → Verify all required skills can load in primary agent
  → If any skill fails to load: STOP, report missing skill name
  → Write workflow-state.yaml (create, set execution_mode: inline)
  → Record OPENCODE-SKILL-RESOLUTION-001 warning in workflow-state.yaml

Phase 1 — Case Design
  → Load skill aws-case-design in primary agent
  → Execute inline
  → Verify: .qa.yaml, proposal.md, cases/<module>/case.yaml exist on disk
  → Update workflow-state.yaml: phases.case_design.status = done

Phase 2 — Case Review (initial)
  → Load skill aws-case-reviewer in primary agent
  → Re-read from disk: workflow-state.yaml, case.yaml, proposal.md
  → Execute inline
  → Read case-review.json from disk
  → Apply case review gate
  → Update workflow-state.yaml: phases.case_review.status

Phase 3 — Case Fix Loop (if gate requires it)
  → For each attempt (max = max_case_fix_attempts):
      → Load skill aws-case-fixer in primary agent
      → Re-read from disk: case-review.json, case.yaml
      → Execute inline
      → Load skill aws-case-reviewer in primary agent
      → Re-read from disk: case.yaml (updated)
      → Execute inline
      → Read new case-review.json from disk
      → Apply case review gate
      → If pass → exit loop, update workflow-state.yaml
      → If reject or human_review_required → stop
      → If attempts exhausted → stop

[API branch — run if test_types includes "api"]

Phase 4A — API Plan
  → Load skill aws-api-plan in primary agent
  → Re-read from disk: workflow-state.yaml, proposal.md, case.yaml
  → Execute inline
  → Verify api-plan.md, api-test-data-plan.md, api-codegen-plan.md exist on disk
  → Update workflow-state.yaml: phases.api_plan.status = done

Phase 5A — API Plan Review (initial)
  → Load skill aws-api-plan-reviewer in primary agent
  → Re-read from disk: workflow-state.yaml, api-plan.md, api-test-data-plan.md, api-codegen-plan.md
  → Execute inline
  → Read api-plan-review.json from disk
  → Apply API plan review gate
  → Update workflow-state.yaml: phases.api_plan_review.status

Phase 6A — API Plan Fix Loop (if gate requires it)
  → For each attempt (max = max_plan_fix_attempts):
      → Load skill aws-api-plan-fixer in primary agent
      → Re-read from disk: api-plan-review.json, api-plan.md
      → Execute inline
      → Load skill aws-api-plan-reviewer in primary agent
      → Re-read from disk: updated plan files
      → Execute inline
      → Read new api-plan-review.json from disk
      → Apply API plan review gate
      → If pass → exit loop, update workflow-state.yaml
      → If reject or human_review_required → stop
      → If attempts exhausted → stop

Phase 7A — API Codegen pre-check
  → Verify `.aws/data-knowledge.yaml` exists on disk
  → If missing: STOP — tell user to create or promote data-knowledge.yaml
  → Update workflow-state.yaml: gates.data_knowledge

Phase 7A — API Codegen
  → Load skill aws-api-codegen in primary agent
  → Re-read from disk: workflow-state.yaml, api-plan.md, api-codegen-plan.md, api-plan-review.json
  → Execute inline
  → Verify tests/api/test_<module>_api.py exists
  → Update workflow-state.yaml: phases.api_codegen.status = done

[E2E branch — run if test_types includes "e2e"]

Phase 4B — E2E Plan
  → Load skill aws-e2e-plan in primary agent
  → Re-read from disk: workflow-state.yaml, proposal.md, case.yaml
  → Execute inline
  → Verify e2e-plan.md, e2e-test-data-plan.md, e2e-codegen-plan.md exist on disk
  → Update workflow-state.yaml: phases.e2e_plan.status = done

Phase 5B — E2E Plan Review (initial)
  → Load skill aws-plan-reviewer in primary agent
  → Re-read from disk: workflow-state.yaml, e2e-plan.md, e2e-test-data-plan.md, e2e-codegen-plan.md
  → Execute inline
  → Read plan-review.json from disk
  → Apply plan review gate
  → Update workflow-state.yaml: phases.e2e_plan_review.status

Phase 6B — E2E Plan Fix Loop (if gate requires it)
  → For each attempt (max = max_plan_fix_attempts):
      → Load skill aws-plan-fixer in primary agent
      → Re-read from disk: plan-review.json, e2e-plan.md
      → Execute inline
      → Load skill aws-plan-reviewer in primary agent
      → Re-read from disk: updated plan files
      → Execute inline
      → Read new plan-review.json from disk
      → Apply plan review gate
      → If pass → exit loop, update workflow-state.yaml
      → If reject or human_review_required → stop
      → If attempts exhausted → stop

Phase 7B — E2E Codegen pre-check
  → Verify `.aws/data-knowledge.yaml` exists on disk
  → If missing: STOP — tell user to create or promote data-knowledge.yaml
  → Update workflow-state.yaml: gates.data_knowledge

Phase 7B — E2E Codegen
  → Load skill aws-e2e-codegen in primary agent
  → Re-read from disk: workflow-state.yaml, e2e-plan.md, e2e-codegen-plan.md, plan-review.json
  → Execute inline
  → Verify tests/e2e/test_<module>_e2e.py exists
  → E2E framework: Python Playwright (test_*_e2e.py + conftest.py)
  → Do NOT generate *.spec.ts files
  → Update workflow-state.yaml: phases.e2e_codegen.status = done

Phase 8 — Test Execution (if run_tests = true)
  → Load skill aws-run in primary agent
  → Re-read from disk: workflow-state.yaml
  → Execute inline: runs aws run --change <change-id> via CLI
  → Primary command: aws run --change <change-id>
  → Fallback API: uv run pytest tests/api/ -v
  → Fallback E2E: uv run pytest tests/e2e/ -v --headed
  → Read result from execution/api-result.json, execution/e2e-result.json on disk
  → Update workflow-state.yaml: phases.execution.status and phases.execution.batch_id

Phase 9 — Inspect / Final Summary
  → Load skill aws-inspect if failures detected OR known-product-issues.md exists
  → Re-read from disk: workflow-state.yaml, execution result files
  → Execute inline
  → Update workflow-state.yaml: phases.inspect.status = done
  → Output structured summary (see Final Response Format)
  → Report agent_warnings from workflow-state.yaml
  → Load skill aws-dashboard if run_dashboard = true

Phase 10 — Archive (optional, if user requests or run_mode = full and all gates pass)
  → Load skill aws-archive in primary agent
  → Re-read from disk: workflow-state.yaml, review JSON files, execution result files
  → Execute inline
  → Archive case delta into qa/cases/, copy artifacts to qa/archive/<change-id>/
  → Update workflow-state.yaml: phases.archive.status = archived | archived_with_known_issues
```

---

## Expected Files per Phase

### Case Design outputs

```text
qa/changes/<change-id>/.qa.yaml
qa/changes/<change-id>/proposal.md
qa/changes/<change-id>/cases/**/*.yaml
```

### Case Review outputs

```text
qa/changes/<change-id>/review/case-review.json
qa/changes/<change-id>/review/case-review-summary.md
```

### API Plan outputs

```text
qa/changes/<change-id>/plans/api-plan.md
qa/changes/<change-id>/plans/api-test-data-plan.md
qa/changes/<change-id>/plans/api-codegen-plan.md
qa/changes/<change-id>/plans/m3-review-summary.md
qa/changes/<change-id>/plans/data-knowledge.proposal.yaml  (only if .aws/data-knowledge.yaml is missing)
```

### E2E Plan outputs

```text
qa/changes/<change-id>/plans/e2e-plan.md
qa/changes/<change-id>/plans/e2e-test-data-plan.md
qa/changes/<change-id>/plans/e2e-codegen-plan.md
qa/changes/<change-id>/plans/m4-review-summary.md
qa/changes/<change-id>/plans/data-knowledge.proposal.yaml  (only if .aws/data-knowledge.yaml is missing)
```

Plan skills MUST NOT write directly to `.aws/data-knowledge.yaml`. Only write proposals to `data-knowledge.proposal.yaml`.

### Plan Review outputs

```text
qa/changes/<change-id>/review/plan-review.json
qa/changes/<change-id>/review/plan-review-summary.md
```

### API Codegen outputs

```text
tests/api/test_<module>_api.py
tests/api/helpers/<module>_api.py
tests/fixtures/<module>_fixtures.py
tests/api/conftest.py
```

Note: execution result files are written by `aws-run` in Phase 8, not by `aws-api-codegen`.

### E2E Codegen outputs

E2E framework: **Python Playwright** — `test_*_e2e.py` files with `pytest --headed`.

```text
tests/e2e/test_<module>_e2e.py      ← Python Playwright test file (NOT *.spec.ts)
tests/e2e/scripts/<module>_data_setup.py
tests/e2e/conftest.py
```

Note: execution result files are written by `aws-run` in Phase 8, not by `aws-e2e-codegen`.

### Execution outputs (written by aws-run, Phase 8)

```text
qa/changes/<change-id>/execution/api-result.json
qa/changes/<change-id>/execution/e2e-result.json
qa/changes/<change-id>/execution/summary.md
qa/changes/<change-id>/execution/known-product-issues.md  ← only if codegen wrote one
qa/changes/<change-id>/execution/runs/<batch-id>/         ← per-run archive
qa/changes/<change-id>/execution/failure-analysis.json  ← written by aws-inspect
qa/changes/<change-id>/execution/failure-summary.md     ← written by aws-inspect
```

Before advancing to the next phase, verify the required output files for the current phase exist. If any required file is missing, stop and report which files are missing.

---

## Mandatory Review JSON Gate

A phase may **never** advance based on natural language approval, a fixer's claim that it fixed something, or an agent's own judgment. Every critical transition is gated by a structured review JSON file written by the corresponding reviewer.

The mandatory gate files are:

| Gate | File | Required before |
|---|---|---|
| Case gate | `qa/changes/<change-id>/review/case-review.json` | API/E2E planning |
| API plan gate | `qa/changes/<change-id>/review/api-plan-review.json` | `aws-api-codegen` |
| E2E plan gate | `qa/changes/<change-id>/review/plan-review.json` | `aws-e2e-codegen` |

**Universal gate rules — applied to every gate file above:**

1. If the required review JSON file does **not exist** → **STOP**.
2. If the file is **not valid JSON** → **STOP**.
3. If the file is missing any **required field** (see field lists below) → **STOP**.
4. If `decision != "pass"` and the state is not an auto-fixable state → **STOP**.

The workflow may only read JSON fields to decide `continue` / `fix` / `stop`. It must not substitute any other signal for these fields.

### Case gate required fields

`qa/changes/<change-id>/review/case-review.json` must contain:

```json
{
  "schema_version": "1.0",
  "review_type": "case",
  "change_id": "<change-id>",
  "decision": "pass|needs_fix|needs_human_review|reject",
  "risk_level": "low|medium|high|critical",
  "auto_fix_allowed": false,
  "human_review_required": false,
  "summary": "",
  "reviewed_files": [],
  "blockers": [],
  "findings": [],
  "needs_review": [],
  "auto_fix_plan": [],
  "next_action": "continue|run_case_fixer|human_review|stop",
  "created_at": "YYYY-MM-DDTHH:mm:ssZ"
}
```

Gate decision:

- `decision == "pass"` → continue to API/E2E planning
- `decision == "reject"` → STOP
- `human_review_required == true` and `force_continue == false` → STOP
- `risk_level in ["high","critical"]` and `force_continue == false` → STOP
- `decision == "needs_fix"` and `auto_fix_allowed == true` → run `aws-case-fixer`
- otherwise → STOP

### API plan gate required fields

`qa/changes/<change-id>/review/api-plan-review.json` must contain:

```json
{
  "schema_version": "1.0",
  "review_type": "api-plan",
  "change_id": "<change-id>",
  "decision": "pass|needs_fix|needs_human_review|reject",
  "risk_level": "low|medium|high|critical",
  "codegen_readiness": "ready|ready_with_warnings|not_ready",
  "auto_fix_allowed": false,
  "human_review_required": false,
  "summary": "",
  "reviewed_files": [],
  "blockers": [],
  "findings": [],
  "needs_review": [],
  "auto_fix_plan": [],
  "next_action": "continue|run_api_plan_fixer|human_review|stop",
  "created_at": "YYYY-MM-DDTHH:mm:ssZ"
}
```

Gate decision:

- `decision == "pass"` and `codegen_readiness in ["ready","ready_with_warnings"]` → continue to `aws-api-codegen`
- `decision == "reject"` → STOP
- `human_review_required == true` and `force_continue == false` → STOP
- `risk_level in ["high","critical"]` and `force_continue == false` → STOP
- `codegen_readiness == "not_ready"` and `force_continue == false` → STOP
- `decision == "needs_fix"` and `auto_fix_allowed == true` → run `aws-api-plan-fixer`
- otherwise → STOP

### E2E plan gate required fields

`qa/changes/<change-id>/review/plan-review.json` must contain:

```json
{
  "schema_version": "1.0",
  "review_type": "e2e-plan",
  "change_id": "<change-id>",
  "decision": "pass|needs_fix|needs_human_review|reject",
  "risk_level": "low|medium|high|critical",
  "codegen_readiness": "ready|ready_with_warnings|not_ready",
  "auto_fix_allowed": false,
  "human_review_required": false,
  "summary": "",
  "reviewed_files": [],
  "blockers": [],
  "findings": [],
  "needs_review": [],
  "auto_fix_plan": [],
  "next_action": "continue|run_plan_fixer|human_review|stop",
  "created_at": "YYYY-MM-DDTHH:mm:ssZ"
}
```

Gate decision:

- `decision == "pass"` and `codegen_readiness in ["ready","ready_with_warnings"]` → continue to `aws-e2e-codegen`
- `decision == "reject"` → STOP
- `human_review_required == true` and `force_continue == false` → STOP
- `risk_level in ["high","critical"]` and `force_continue == false` → STOP
- `codegen_readiness == "not_ready"` and `force_continue == false` → STOP
- `decision == "needs_fix"` and `auto_fix_allowed == true` → run `aws-plan-fixer`
- otherwise → STOP

---

## User Approval Is Not a Gate Artifact

Natural language approval from the user is **not** sufficient to advance to codegen or archive.

If the user manually approves a plan, the corresponding reviewer must still write the review JSON file recording that approval:

- User approves case artifacts → `aws-case-reviewer` must write `case-review.json`
- User approves API plan → `aws-api-plan-reviewer` must write `api-plan-review.json`
- User approves E2E plan → `aws-plan-reviewer` must write `plan-review.json`

The workflow must never proceed based only on messages such as:

```text
approved
looks good
proceed to codegen
```

These messages may be used as **input** to the reviewer, but the reviewer must still produce the machine-readable JSON gate. Only a freshly written review JSON with `decision == "pass"` releases the gate.

---

## Retry Must Be Based on JSON

The fix/review loop is driven entirely by review JSON, never by claims:

```text
reviewer writes JSON
workflow reads JSON
if decision == needs_fix and auto_fix_allowed == true → run fixer
fixer applies changes and writes apply-summary (NOT review JSON)
reviewer runs again and writes a NEW review JSON
workflow reads the new JSON
only decision == pass can continue
```

Forbidden transitions:

- ❌ fixer says "fixed" → continue
- ❌ reviewer says "looks good" in chat → continue
- ❌ user says "approved" → continue

Required transition:

- ✅ new review JSON `decision == "pass"` → continue

---

## Subagent Failure Does Not Bypass the Gate

If a subagent fails or is unavailable, the workflow may run the corresponding skill **inline** in the current agent context. Inline fallback is allowed **only** to generate the same required artifacts — including the same review JSON files.

- Subagent fails → inline reviewer may generate the review JSON.
- Subagent fails → you may **not** skip review and proceed directly to codegen or archive.

Every gate listed in **Mandatory Review JSON Gate** applies identically whether the phase ran in a subagent or inline.

---

## Case Review Gate

Read `qa/changes/<change-id>/review/case-review.json` and apply this gate:

| Condition | Action |
|---|---|
| `decision == "pass"` | Continue to API/E2E plan (per test_types) |
| `decision == "reject"` | **Stop** |
| `human_review_required == true` | **Stop** unless `force_continue = true` |
| `risk_level in ["high", "critical"]` | **Stop** unless `force_continue = true` |
| `decision == "needs_fix"` and `auto_fix_allowed == true` | Run `aws-case-fixer` |
| Any other condition | **Stop** and ask for human review |

**Case review retry policy:**

- Initial case review does not count as a fix attempt.
- Max fix attempts: `max_case_fix_attempts` (default 2).
- Max total case review runs: `max_case_fix_attempts + 1` (default 3).
- If fix attempts are exhausted and decision is still not `pass`, stop.

---

## API Plan Review Gate

Read `qa/changes/<change-id>/review/api-plan-review.json` and apply this gate:

| Condition | Action |
|---|---|
| `decision == "pass"` | Continue to API codegen |
| `decision == "reject"` | **Stop** |
| `human_review_required == true` | **Stop** unless `force_continue = true` |
| `risk_level in ["high", "critical"]` | **Stop** unless `force_continue = true` |
| `codegen_readiness == "not_ready"` | **Stop** unless `force_continue = true` |
| `decision == "needs_fix"` and `auto_fix_allowed == true` | Run `aws-api-plan-fixer` |
| Any other condition | **Stop** and ask for human review |

**API plan review retry policy:**

- Initial API plan review does not count as a fix attempt.
- Max fix attempts: `max_plan_fix_attempts` (default 2).
- Max total API plan review runs: `max_plan_fix_attempts + 1` (default 3).
- If fix attempts are exhausted and decision is still not `pass`, stop.

---

## E2E Plan Review Gate

Read `qa/changes/<change-id>/review/plan-review.json` and apply this gate:

| Condition | Action |
|---|---|
| `decision == "pass"` | Continue to E2E codegen |
| `decision == "reject"` | **Stop** |
| `human_review_required == true` | **Stop** unless `force_continue = true` |
| `risk_level in ["high", "critical"]` | **Stop** unless `force_continue = true` |
| `codegen_readiness == "not_ready"` | **Stop** unless `force_continue = true` |
| `decision == "needs_fix"` and `auto_fix_allowed == true` | Run `aws-plan-fixer` |
| Any other condition | **Stop** and ask for human review |

**E2E plan review retry policy:**

- Initial E2E plan review does not count as a fix attempt.
- Max fix attempts: `max_plan_fix_attempts` (default 2).
- Max total E2E plan review runs: `max_plan_fix_attempts + 1` (default 3).
- If fix attempts are exhausted and decision is still not `pass`, stop.

---

## Stop Conditions

Stop the workflow immediately when any of the following is true:

- Required input files are missing and cannot be generated by the current phase
- Review JSON is missing or is invalid JSON
- `decision == "reject"` in any review
- `human_review_required == true` and `force_continue == false`
- `risk_level in ["high", "critical"]` and `force_continue == false`
- `codegen_readiness == "not_ready"` and `force_continue == false`
- Fix attempt count exceeds `max_case_fix_attempts` or `max_plan_fix_attempts`
- Codegen requires guessing unknown product behavior (route, auth, selector, factory)
- `.aws/data-knowledge.yaml` is missing before codegen phase (see Phase 7A/7B pre-check)
- Test execution environment is unavailable (`aws` CLI or uv/pytest not installed)
- A subagent returns an unrecoverable error
- Background subagent watchdog fired and foreground retry failed for `api_plan`, `e2e_plan`, `api_codegen`, or `e2e_codegen`

When stopped, report the exact stop reason, which file or gate triggered it, and what a human must do to resume.

---

## Final Response Format

After the workflow completes or stops, always output this structure:

```
AWS workflow completed | stopped.

Status: completed | stopped
Change ID: <change-id>
Current phase: <phase that completed or stopped>
Stop reason: <if stopped>

Review gates:
  case-review.json: present | missing | invalid | pass | needs_fix | reject
  api-plan-review.json: present | missing | invalid | pass | needs_fix | reject | not_applicable
  plan-review.json: present | missing | invalid | pass | needs_fix | reject | not_applicable

Case files:
  .qa.yaml: present | missing
  proposal.md: present | missing
  cases: <N files>

Case review:
  decision: <pass | needs_fix | reject | human_review | —>
  risk_level: <low | medium | high | critical | —>
  fix attempts used: <N>

API plan files:
  api-plan.md: present | missing
  api-codegen-plan.md: present | missing
  api plan review: <pass | needs_fix | reject | —>
  api plan fix attempts: <N>

E2E plan files:
  e2e-plan.md: present | missing
  e2e-test-data-plan.md: present | missing
  e2e-codegen-plan.md: present | missing
  e2e plan review: <pass | needs_fix | reject | —>
  e2e plan fix attempts: <N>

Generated test files:
  tests/api/: <N files>
  tests/e2e/: <N files> (Python Playwright, test_*_e2e.py)

Execution result:
  command: aws run --change <change-id> | fallback
  api: <passed | passed_with_known_issues | failed | skipped | —>
  e2e: <passed | passed_with_known_issues | failed | skipped | —>

Known product issues:
  count: <N>
  status: none | present
  files:
    - qa/changes/<change-id>/execution/known-product-issues.md
    - qa/changes/<change-id>/inspect/known-product-issues.md

Risk status: clean | passed_with_known_issues | failed

Execution mode: inline (no subagents used)

Agent Warnings:
  - OPENCODE-SKILL-RESOLUTION-001: workflow executed inline because subagent skill inheritance is unreliable.
  <additional watchdog incidents if any>:
    - phase: <api_plan | e2e_plan | api_codegen | e2e_codegen>
      issue: <idle timeout | total timeout>
      action: retried foreground
      retry_result: <passed | failed>
  (if no additional incidents: none)

Warnings:
  - <any warnings>

Next action:
  <what the user should do next>
```

Do not report any phase as complete unless its expected output files exist and were verified.

Do not claim the workflow succeeded if it stopped before Phase 9.

Do not report the workflow as completed unless every applicable review gate (`case-review.json`, and `api-plan-review.json` / `plan-review.json` per `test_types`) is present, valid, and has `decision == "pass"`.

---

## Known Product Issue Reporting

The workflow must distinguish between:

```text
tests passed cleanly
tests passed with known product issues
tests failed
```

If any of the following exist, the final workflow `Status` must be `completed_with_known_issues`, not `completed`:

- `qa/changes/<change-id>/execution/known-product-issues.md`
- `qa/changes/<change-id>/inspect/known-product-issues.md`
- `execution/api-result.json` or `execution/e2e-result.json` contains `known_product_issues.count > 0`

The final summary must explicitly mention:

- Affected endpoint or feature
- Severity
- Workaround used
- Coverage gap
- Status
- Next action

### Forbidden Final Summary Language (when known product issues exist)

Never use:

```text
no risk
fully clean
clean pass
all good
no issues
completed
```

Use instead:

```text
completed_with_known_issues
passed_with_known_issues
archived_with_known_issues
```
