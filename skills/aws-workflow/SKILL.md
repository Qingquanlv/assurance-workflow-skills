---
name: aws-workflow
description: "Run the full AWS QA workflow inline in the primary agent — loads each phase skill (case-design, case-reviewer, api-plan, e2e-plan, plan-reviewer, api-codegen, e2e-codegen, aws-run, aws-inspect, aws-fix-proposal, aws-api-codegen-fixer, aws-e2e-codegen-fixer) sequentially in the same context. No subagent skill loading. Phase state tracked via workflow-state.yaml."
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
| `max_plan_fix_attempts` | `2` | Max times to run aws-e2e-plan-fixer before giving up |
| `force_continue` | `false` | Bypass **only** `human_review_required` and `risk_level in ["high","critical"]` stops. **Must NOT** bypass codegen hard gates (see **Codegen Hard Gates** and **force_continue Boundaries**) |
| `run_dashboard` | `false` | Whether to launch aws-dashboard after completion |
| `run_tests` | `true` | Whether to execute tests via aws-run after codegen |
| `max_healing_attempts` | `2` | Max healing attempts after inspect finds `fix_proposal_eligible` failures |
| `auto_archive` | `false` | Whether to archive automatically after successful execution/healing (default: off) |
| `auto_archive_with_fallback` | `false` | Allow auto-archive when `PASS_WITH_WARNINGS` was caused by fallback runner (requires inspect done/partial + explicit opt-in) |
| `e2e_framework` | `python-playwright` | Runtime parameter — E2E stack selection (`python-playwright` only; TS Playwright not supported). Maps to `phases.e2e_codegen.generated_tests.framework: pytest-playwright` in workflow-state. |


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
| `codegen-only` | Per `test_types`: `plans/api-plan.md`, `plans/api-test-data-plan.md`, `plans/api-codegen-plan.md`, `review/api-plan-review.json` (API); `plans/e2e-plan.md`, `plans/e2e-test-data-plan.md`, `plans/e2e-codegen-plan.md`, `plans/m4-review-summary.md`, `review/plan-review.json` (E2E); `.aws/data-knowledge.yaml` (always) |
| `review-case` | `qa/changes/<change-id>/cases/**/*.yaml` |
| `review-plan` | Per `test_types`: API — `plans/api-plan.md`, `plans/api-test-data-plan.md`, `plans/api-codegen-plan.md`, `plans/m3-review-summary.md`; E2E — `plans/e2e-plan.md`, `plans/e2e-test-data-plan.md`, `plans/e2e-codegen-plan.md`, `plans/m4-review-summary.md` |

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
  - aws-e2e-plan-reviewer
  - aws-api-plan-fixer
  - aws-e2e-plan-fixer
  - aws-api-codegen
  - aws-e2e-codegen
  - aws-run
  - aws-inspect
  - aws-archive

healing_skills:
  - aws-fix-proposal        # Phase 10: generate fix proposals from failure-analysis.json
  - aws-api-codegen-fixer   # Phase 11A: apply API test code fixes
  - aws-e2e-codegen-fixer   # Phase 11B: apply E2E test code fixes
  # Required for healing loop when max_healing_attempts > 0.
  # Missing healing skills do NOT block Phases 1–9, but set gates.healing_available = false.
  # If execution later FAIL and eligible failures exist: STOP after Phase 9 — cannot heal.
```

After verifying required skills, **write `workflow-state.yaml`** with the initial `subagents` block:

```yaml
subagents:
  used: false
  purpose: []
  loaded_skills: false
  affected_gates: false
```

If explore agents were invoked **strictly before Phase 0** for source-only reading (the only permitted case — see **Conflict with analyze-mode / search-mode pre-exploration**):

- Set `subagents.used = true`
- Add `source_exploration_only` to `subagents.purpose`
- Confirm `subagents.loaded_skills = false` (they must not have loaded AWS skills)
- Confirm `subagents.affected_gates = false` (they must not have written or substituted gate artifacts)

**If search-mode or analyze-mode agents were launched at or after Phase 0** — this is a forbidden-pattern violation: STOP, set `subagents.affected_gates = true`.
- Record in `agent_warnings`:

```yaml
- id: AWS-SUBAGENT-EXPLORATION-ONLY
  severity: info
  title: Subagents used for source exploration only
  detail: >
    Explore agents or document-driven subagents were invoked for source/structure
    exploration. No AWS skill was loaded by any subagent. No gate artifact was
    produced by a subagent. All AWS phases executed inline in the primary agent.
  status: acknowledged
```

If a subagent is found to have **loaded an AWS skill** or **produced a gate artifact**, set `subagents.loaded_skills = true` or `subagents.affected_gates = true` and **STOP** — this is a forbidden pattern violation.

---

If any **required** skill fails to load via the skill tool:

First, attempt the **on-disk fallback**:

- Verify the skill's `SKILL.md` exists on disk at the expected skill path.
- If it exists: read the file directly, follow its instructions inline, and record a `SKILL-TOOL-UNREGISTERED` warning in `workflow-state.yaml`.
- Treat on-disk direct read as functionally equivalent to `use skill <name>` — the LLM reads and follows the skill content either way.

Only **STOP** if the skill cannot be loaded **and** its `SKILL.md` does not exist on disk:

- Report the missing skill name.
- Do not start case design.
- Do **not** check subagent skill resolution — this workflow does not use subagent skill loading.

**Fixed warning — skill tool registration failure with on-disk fallback:**

```yaml
- id: SKILL-TOOL-UNREGISTERED
  severity: low
  title: Skill exists on disk but not registered with skill tool
  detail: >
    One or more required skills could not be loaded via the skill tool but
    were found on disk. The workflow will read SKILL.md directly as an equivalent
    fallback. This may indicate a skill path conflict or OpenCode registration
    timing issue.
  affected_skills: []   # list skill names here
  status: acknowledged
```

If any **healing_skills** fail to load:

- Do **not** stop at Phase 0 — phases 1–9 are unaffected.
- Record warning in `workflow-state.yaml` under `agent_warnings`:
  - `AWS-HEALING-SKILLS-UNAVAILABLE` (fixed ID — see below)
- Set `gates.healing_available = false` in `workflow-state.yaml`.
- If `phases.execution.status == FAIL` and `inspect/failure-analysis.json` contains `fix_proposal_eligible` failures, **STOP** after Phase 9 and report that healing skills are unavailable — do not proceed to archive.
- If `phases.execution.status in [PASS, PASS_WITH_WARNINGS]`, healing is not needed and can be skipped safely.

**When `max_healing_attempts == 0`:** treat healing as disabled regardless of whether healing skills loaded. Set `gates.healing_available = false` and `phases.healing.status = skipped`.

**Fixed warning — healing skills unavailable:**

```yaml
- id: AWS-HEALING-SKILLS-UNAVAILABLE
  severity: medium
  title: Healing skills are unavailable or disabled
  impact:
    - healing loop cannot run if execution fails with eligible failures
    - STOP after Phase 9 if FAIL with eligible failures
  status: acknowledged
```

---

## Inline Skill Routing

All phases load skills and execute **in the primary agent**. No subagents or tasks are used.

| Phase | Skill to Load |
|---|---|
| Phase 0: Registry Check | (verify all required skills above) |
| Phase 1: Case Design | `aws-case-design` |
| Phase 2: Case Review | `aws-case-reviewer` |
| Phase 3: Case Fix | `aws-case-fixer` |
| Phase 3.5: Fact Baseline | *(inline — no separate skill; primary agent reads seed/DB)* |
| Phase 4A: API Plan | `aws-api-plan` |
| Phase 4B: E2E Plan | `aws-e2e-plan` |
| Phase 5A: API Plan Review | `aws-api-plan-reviewer` |
| Phase 5B: E2E Plan Review | `aws-e2e-plan-reviewer` |
| Phase 6A: API Plan Fix | `aws-api-plan-fixer` |
| Phase 6B: E2E Plan Fix | `aws-e2e-plan-fixer` |
| Phase 7A: API Codegen | `aws-api-codegen` |
| Phase 7B: E2E Codegen | `aws-e2e-codegen` |
| Phase 8: Execution | `aws-run` |
| Phase 9: Inspect / Failure Analysis | `aws-inspect` |
| Phase 10: Fix Proposal *(healing, optional)* | `aws-fix-proposal` |
| Phase 11A: API Codegen Fix *(healing, optional)* | `aws-api-codegen-fixer` |
| Phase 11B: E2E Codegen Fix *(healing, optional)* | `aws-e2e-codegen-fixer` |
| Phase 12: Re-run *(healing)* | `aws-run` |
| Phase 13: Re-inspect *(healing)* | `aws-inspect` |
| Phase 14: Archive | `aws-archive` |
| Post-workflow (optional): Dashboard | `aws-dashboard` (only when `run_dashboard = true`) |

After each phase, **update `workflow-state.yaml`** before loading the next skill.

---

## Phase Completion Rule

Loading a skill is **never** enough to mark a phase complete.

A phase is complete only when **all** of the following are true:

1. The phase skill executed **inline in the primary agent** — not in a subagent, not in a background task.
2. The expected output files exist on disk (verified by reading them).
3. The output files were **re-read from disk** by the primary agent after the skill completed.
4. `workflow-state.yaml` was updated for that phase (status set to the correct terminal value).
5. The next-phase gate was explicitly evaluated before advancing.
6. **Shadow CLI status check ran after the phase update**:
   - Run `aws status --change <change-id> --json` after every phase that writes or updates workflow artifacts.
   - If the completed phase has a schema gate, also run `aws gate check --change <change-id> --phase <phase-id> --json`.
   - These CLI commands do **not** run automatically; the primary agent must invoke them explicitly.
   - In shadow mode, CLI output is **advisory only**. Do not replace the prose workflow gates or stop/advance rules with CLI output yet.
   - If CLI output disagrees with this skill's prose decision, append an `AWS-ORCHESTRATION-SHADOW-DISAGREEMENT` entry to `workflow-state.yaml.agent_warnings[]` and report it in the final response.
   - If the CLI command itself fails because the CLI is unavailable, schema validation fails, or the schema file is missing, append `AWS-ORCHESTRATION-SHADOW-UNAVAILABLE` to `agent_warnings[]`. Do not stop the workflow for shadow-only CLI failure unless the same condition is already a prose gate failure.

Do **not** report a phase as done based on:

- skill loaded
- subagent started
- subagent completed
- background task completed
- chat summary from an agent
- agent claim without file verification
- partial output (some files present but not all required outputs)

**Codegen phases are especially strict** — see Phase 7A and Phase 7B Inline Execution Rules.

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

subagents:
  used: false          # true if any subagent (explore / document-driven / forbidden) was invoked during this workflow run
  purpose:             # list — valid values: source_exploration_only | document_driven_parallel | forbidden_codegen_attempt
    []
  loaded_skills: false          # MUST remain false — subagents MUST NOT successfully load AWS skills
  attempted_skill_loading: false # true if any subagent attempted to load an AWS skill (success OR failure)
  attempted_phase_execution: false # true if any subagent attempted to execute an AWS phase (success OR failure)
  affected_gates: false         # MUST remain false — subagents MUST NOT produce or substitute gate artifacts

phases:
  skill_registry_check:
    status: pass | fail | skipped
    reason: <optional — e.g. standalone aws-case-design invocation>
    checked_skills:
      - aws-case-design
      - aws-case-reviewer
      - aws-case-fixer
      - aws-api-plan
      - aws-e2e-plan
      - aws-api-plan-reviewer
      - aws-e2e-plan-reviewer
      - aws-api-plan-fixer
      - aws-e2e-plan-fixer
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
    fix_attempts: []   # appended by aws-case-fixer each run

  fact_baseline:
    status: pending | done | unavailable
    # unavailable = seed file not found AND db_probe not configured; planning continues with warning
    source: null      # seed_file | db_probe | both | unavailable
    file: facts/fact-baseline.json

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
    status: pending | pass | needs_fix | needs_human_review | reject | stale
    # stale = review JSON was written before a fact correction; it cannot gate codegen until re-reviewed
    # reason: fact_correction_after_review | fact_mismatch_before_review
    stale_reason: null
    gate_file: review/api-plan-review.json
    fix_attempts: []   # appended by aws-api-plan-fixer each run

  e2e_plan_review:
    status: pending | pass | needs_fix | needs_human_review | reject | stale
    stale_reason: null
    gate_file: review/plan-review.json
    fix_attempts: []   # appended by aws-e2e-plan-fixer each run

  api_codegen:
    status: pending | done | failed | stopped | needs_patch
    # needs_patch = codegen completed but generated tests contain stale facts (e.g. wrong role name)
    # requires manual patch + re-collect before Phase 8 can proceed
    stop_reason: null   # set when status == stopped; e.g. "codegen delegated to background subagent; must execute inline in primary agent"
    needs_patch_reason: null  # set when status == needs_patch; e.g. "stale_role_name_fact"
    review_gate_file: review/api-plan-review.json
    codegen_readiness: ready | ready_with_warnings
    generated_tests:
      framework: pytest
      language: python
      files: []
      semantic_validity: valid | stale   # stale = generated with stale facts; set to valid after patch+collect
    warnings_carried: []
    known_product_issues:
      present: false
      file: null

  e2e_codegen:
    status: pending | done | failed | stopped | needs_patch
    stop_reason: null   # set when status == stopped; e.g. "codegen delegated to background subagent; must execute inline in primary agent"
    needs_patch_reason: null
    review_gate_file: review/plan-review.json
    codegen_readiness: ready | ready_with_warnings
    generated_tests:
      framework: pytest-playwright   # from runtime e2e_framework=python-playwright
      language: python
      files: []
      semantic_validity: valid | stale
    data_setup:
      scripts: []
      reused: []
    fixtures:
      generated: []
      reused: []
    warnings_carried: []
    known_product_issues:
      present: false
      file: null

  execution:
    status: pending | PASS | PASS_WITH_WARNINGS | FAIL | SKIPPED
    batch_id: <YYYYMMDD-HHmmss>
    manifest: execution/execution-manifest.yaml

  inspect:
    status: pending | done | failed | partial   # partial = fallback mode without classification
    inspect_mode: primary | partial              # primary = CLI classified; partial = fallback summary only
    classification_performed: true | false
    outputs:
      - inspect/failure-analysis.json           # primary mode only (source of truth)
      - inspect/failure-summary.md              # source of truth
      - inspect/inspection-partial.json       # partial mode only
      - inspect/known-product-issues.md         # if known issues found or confirmed
      - inspect/inspection-error.json         # if primary CLI failed / outputs missing
      # execution/ copies are optional pointers for downstream consumers

  healing:
    status: pending | not_needed | proposal_created | applied | resolved | exhausted | skipped | failed
    # Status transitions:
    #   pending          → initial value
    #   not_needed       → no eligible failures after inspect, or eligible_count == 0 from fix-proposal
    #   proposal_created → Phase 10 wrote fix-proposal.json with eligible_count > 0
    #   applied          → Phase 11 fixers ran and Fixer Safety Gate passed (set by orchestrator)
    #   resolved         → Phase 13 re-inspect shows PASS or PASS_WITH_WARNINGS (healing succeeded)
    #   exhausted        → max_healing_attempts reached, still FAIL (set at end of Phase 13 loop)
    #   skipped          → healing disabled (gates.healing_available == false or max_healing_attempts == 0)
    #   failed           → fixer hard error (forbidden file, patch mismatch, fixer-error.json written)
    attempts: []
    # Each attempt:
    # - attempt: <n>
    #   source_analysis: inspect/failure-analysis.json
    #   eligible_failures: [<id>, ...]
    #   proposal_file: healing/fix-proposal.md
    #   proposal_json: healing/fix-proposal.json
    #   api_apply_status: applied | no_op | failed    # set by aws-api-codegen-fixer
    #   api_apply_summary: healing/api-apply-summary.json
    #   e2e_apply_status: applied | no_op | failed    # set by aws-e2e-codegen-fixer
    #   e2e_apply_summary: healing/e2e-apply-summary.json
    #   applied_files: [<path>, ...]                  # aggregate, set by orchestrator after safety gate
    #   rerun_batch_id: <YYYYMMDD-HHmmss>             # set after Phase 12
    #   result: PASS | PASS_WITH_WARNINGS | FAIL | SKIPPED   # set after Phase 13
    #   stop_reason: <if result == stopped or failed>
    # NOTE: phases.healing.status = applied is set by the orchestrator ONLY after
    #       both fixers complete (api_apply_status and e2e_apply_status resolved)
    #       and the Fixer Safety Gate passes.

  archive:
    status: pending | archived | archived_with_warnings | skipped

gates:
  data_knowledge:
    status: present | missing
    decision: pass | stop   # force_continue MUST NOT bypass this gate before codegen
  healing_available: true | false   # true if all healing_skills loaded AND max_healing_attempts > 0; false otherwise

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
  # Shadow-mode CLI orchestration warnings (written only when applicable).
  # The CLI is advisory until the workflow explicitly migrates from prose gates
  # to authoritative CLI gates.
  - id: AWS-ORCHESTRATION-SHADOW-DISAGREEMENT
    severity: medium | high
    phase: <phase-id>
    command: aws status | aws gate check
    prose_decision:
      status: <done | stopped | next phase | gate verdict>
      reason: <brief prose-gate reason>
    cli_decision:
      status: <CLI phase status or gate verdict>
      next: [<phase-id>, ...]
      terminal: <null | stopped | completed>
    action_taken: followed_prose_workflow
    status: recorded
  - id: AWS-ORCHESTRATION-SHADOW-UNAVAILABLE
    severity: low
    phase: <phase-id>
    command: aws status | aws gate check
    error: <CLI unavailable | schema missing | schema validation failed | command failed>
    action_taken: continued_with_prose_workflow
    status: recorded
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

### Phase 3.5 — Fact Baseline

```yaml
inputs:
  - workflow-state.yaml
  - app/core/init_app.py (or equivalent seed/fixture file)
  - .aws/config.yaml (for db_probe flag)
  - live DB read-only probe (optional, if db_probe: true in config)
outputs:
  - facts/fact-baseline.json
  - workflow-state.yaml (updated: phases.fact_baseline.status)
gate: facts/fact-baseline.json must exist before Phase 5A or 5B run
```

**fact-baseline.json schema:**

```json
{
  "change_id": "<change-id>",
  "generated_at": "<ISO timestamp>",
  "source": "seed_file | db_probe | both",
  "seed_file": "<path to seed/init file read>",
  "facts": {
    "builtin_roles": [
      {"id": 1, "name": "管理员", "source": "seed_file"}
    ],
    "auth": {
      "default_username": "admin",
      "default_password": "<from seed>",
      "source": "seed_file"
    },
    "route_prefix": "/api/v1",
    "token_header": "Authorization",
    "token_scheme": "Bearer"
  },
  "warnings": []
}
```

If the seed file cannot be found and db_probe is false, write `fact-baseline.json` with `"source": "unavailable"` and record a warning — do **not** STOP; continue to Phase 4 but planners must note that fact validation is skipped.

### Phase 4A — API Plan

```yaml
inputs:
  - workflow-state.yaml
  - proposal.md
  - cases/<module>/case.yaml
  - .aws/config.yaml
  - .aws/data-knowledge.yaml (or plans/data-knowledge.proposal.yaml)
  - facts/fact-baseline.json   ← NEW: validate key facts before writing plan
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
  - plans/m3-review-summary.md
  - review/api-plan-review.json  # full gate — see Codegen Hard Gates
  - .aws/data-knowledge.yaml     # must exist on disk
outputs:
  - files listed in api-codegen-plan.md Target Files only
    # helpers / fixtures / conftest are optional — only when plan + data-knowledge authorize
  - qa/changes/<change-id>/codegen/api-codegen-summary.md
  - workflow-state.yaml (updated: review_gate_file, codegen_readiness, generated_tests.files, warnings_carried, known_product_issues)
gate:
  - Codegen Hard Gates (API) — force_continue MUST NOT bypass
```

### Phase 7A Inline Execution Rule

`aws-api-codegen` **MUST execute inline in the primary agent**. Loading the skill is not phase completion.

**Forbidden:**

```text
❌ delegate_task for aws-api-codegen
❌ background API codegen agent
❌ treating subagent or background task output as Phase 7A completion
```

If a subagent or background task is used to attempt API codegen — **regardless of whether skill loading succeeded** — STOP immediately:

- Set `phases.api_codegen.status = stopped` and `phases.api_codegen.stop_reason = "codegen delegated to background subagent; must execute inline in primary agent"`.
- Update `subagents`:
  - `used = true`
  - `purpose = [forbidden_codegen_attempt]`
  - `loaded_skills = true` only if the subagent **successfully** loaded an AWS skill; otherwise keep `false`
  - `attempted_skill_loading = true` if the subagent attempted to load any AWS skill (whether or not it succeeded)
  - `attempted_phase_execution = true` (always set when a codegen subagent is spawned)
  - `affected_gates = false`
- Do **not** proceed to any later phase.
- Require the primary agent to re-run the affected codegen phase inline.

**Phase 7A is complete only when all are true:**

1. `aws-api-codegen` executed inline in the primary agent.
2. No subagent or background task executed API codegen.
3. All files listed in `api-codegen-plan.md` Target Files exist on disk (re-read by primary agent).
4. `qa/changes/<change-id>/codegen/api-codegen-summary.md` exists on disk.
5. `workflow-state.yaml` has `phases.api_codegen.status = done`.
6. `workflow-state.yaml` lists `generated_tests.files`, `warnings_carried`, and `known_product_issues`.

If any condition fails, **STOP** and report the exact missing condition.

### Phase 7B — E2E Codegen

```yaml
inputs:
  - workflow-state.yaml
  - plans/e2e-plan.md
  - plans/e2e-test-data-plan.md
  - plans/e2e-codegen-plan.md
  - plans/m4-review-summary.md
  - review/plan-review.json  # full gate — see Codegen Hard Gates
  - .aws/data-knowledge.yaml # must exist on disk
outputs:
  - files listed in e2e-codegen-plan.md Target Files only
    # scripts / fixtures / conftest are optional — only when plan + data-knowledge authorize
  - qa/changes/<change-id>/codegen/e2e-codegen-summary.md
  - workflow-state.yaml (updated: review_gate_file, codegen_readiness, generated_tests.files, data_setup, fixtures, warnings_carried, known_product_issues)
gate:
  - Codegen Hard Gates (E2E) — force_continue MUST NOT bypass
```

### Phase 7B Inline Execution Rule

`aws-e2e-codegen` **MUST execute inline in the primary agent**. Loading the skill is not phase completion.

**Forbidden:**

```text
❌ delegate_task for aws-e2e-codegen
❌ background E2E codegen agent
❌ treating subagent or background task output as Phase 7B completion
```

If a subagent or background task is used to attempt E2E codegen — **regardless of whether skill loading succeeded** — STOP immediately:

- Set `phases.e2e_codegen.status = stopped` and `phases.e2e_codegen.stop_reason = "codegen delegated to background subagent; must execute inline in primary agent"`.
- Update `subagents`:
  - `used = true`
  - `purpose = [forbidden_codegen_attempt]`
  - `loaded_skills = true` only if the subagent **successfully** loaded an AWS skill; otherwise keep `false`
  - `attempted_skill_loading = true` if the subagent attempted to load any AWS skill (whether or not it succeeded)
  - `attempted_phase_execution = true` (always set when a codegen subagent is spawned)
  - `affected_gates = false`
- Do **not** proceed to any later phase.
- Require the primary agent to re-run the affected codegen phase inline.

**Phase 7B is complete only when all are true:**

1. `aws-e2e-codegen` executed inline in the primary agent.
2. No subagent or background task executed E2E codegen.
3. All files listed in `e2e-codegen-plan.md` Target Files exist on disk (re-read by primary agent).
4. `qa/changes/<change-id>/codegen/e2e-codegen-summary.md` exists on disk.
5. `workflow-state.yaml` has `phases.e2e_codegen.status = done`.
6. `workflow-state.yaml` lists `generated_tests.files`, `data_setup`, `fixtures`, `warnings_carried`, and `known_product_issues`.

If any condition fails, **STOP** and report the exact missing condition.

### Phase 8 — Execution

```yaml
inputs:
  - workflow-state.yaml
  - generated test files (from phases 7A/7B)
  - .aws/config.yaml
outputs:
  - execution/runs/<batch-id>/api-result.json       # only if manifest.selected_targets.api == true
  - execution/runs/<batch-id>/e2e-result.json       # only if manifest.selected_targets.e2e == true
  - execution/runs/<batch-id>/summary.md              # primary mode — always in batch dir
  - execution/runs/<batch-id>/execution-manifest.yaml # skill-written, always
  - execution/api-result.json    (latest pointer — only if api selected)
  - execution/e2e-result.json    (latest pointer — only if e2e selected)
  - execution/summary.md         (latest pointer — always required in primary mode)
  - execution/execution-manifest.yaml  (latest pointer, always)
  - execution/known-product-issues.md  (snapshot from qa/changes/<change-id>/known-product-issues.md if present)
  - workflow-state.yaml (updated: phases.execution.status = PASS|PASS_WITH_WARNINGS|FAIL|SKIPPED)
rules:
  - Do not fail because an unselected target result file is absent.
runner:
  primary: aws run --change <change-id>
  fallback: direct pytest — only when .aws/config.yaml has allow_direct_pytest_fallback:true
            OR user explicitly accepts fallback risk.
            Fallback pass → final_status MUST be PASS_WITH_WARNINGS, never PASS.
            No fallback allowed + CLI missing → final_status MUST be FAIL.
gate:
  - verify execution/execution-manifest.yaml exists after run
  - read final_status from manifest, not from chat or claim
```

### Phase 9 — Inspect / Failure Analysis

```yaml
inputs:
  - workflow-state.yaml
  - execution/execution-manifest.yaml          # required; stop if missing
  - execution/summary.md
  - execution/api-result.json                  # only if execution-manifest selected_targets.api == true
  - execution/e2e-result.json                  # only if execution-manifest selected_targets.e2e == true
  - execution/known-product-issues.md          # if present (codegen-level snapshot)
outputs:
  - inspect/failure-analysis.json              # primary mode only (source of truth)
  - inspect/failure-summary.md                 # source of truth
  - inspect/inspection-partial.json            # partial mode only
  - inspect/known-product-issues.md            # if known issues found or confirmed
  - execution/failure-analysis.json            # optional copy/pointer for downstream (primary mode)
  - execution/failure-summary.md               # optional copy/pointer for downstream
  - human-readable final report
  - workflow-state.yaml (updated: phases.inspect.status, inspect_mode, classification_performed)
status_update_rules:
  - primary mode: phases.inspect.status = done, inspect_mode = primary, classification_performed = true
  - partial mode: phases.inspect.status = partial, inspect_mode = partial, classification_performed = false
  - PASS → PASS_WITH_WARNINGS allowed if known_product_issue or coverage_gap confirmed (primary mode only)
  - FAIL → never changed to PASS by inspect
  - PASS_WITH_WARNINGS → never changed to PASS by inspect
```

### Phase 10 — Fix Proposal *(healing, optional)*

```yaml
trigger: inspect/failure-analysis.json contains failures with fix_proposal_eligible == true
requires:
  - phases.inspect.inspect_mode == primary
  - phases.inspect.classification_performed == true
  - inspect/failure-analysis.json exists
inputs:
  - workflow-state.yaml
  - inspect/failure-analysis.json
  - inspect/failure-summary.md
  - execution/execution-manifest.yaml
  - generated test files (tests/api/ and/or tests/e2e/)
outputs:
  - healing/fix-proposal.md
  - healing/fix-proposal.json
  - workflow-state.yaml (updated: phases.healing.status = proposal_created)
gate:
  - only failures where fix_proposal_eligible == true
  - known_product_issue / coverage_gap / business_logic_failure are NOT eligible
```

### Phase 11A — API Codegen Fix *(healing)*

```yaml
inputs:
  - healing/fix-proposal.json           (proposals with target==api, eligible==true, risk_level in [low, medium])
  - workflow-state.yaml                  (phases.healing.status must be proposal_created)
  - inspect/failure-analysis.json
  - codegen/api-codegen-summary.md       (trusted source for allowed files)
outputs:
  - tests/api/test_<module>_api.py       (modified — only if proposal targets it)
  - healing/api-apply-summary.json       (required)
  - healing/api-apply-summary.md         (required)
  - healing/api-fixer-error.json         (written only on hard error)
  - workflow-state.yaml (updated: attempts[n].api_apply_status = applied | no_op | failed)
rules:
  - do NOT change product code (app/, web/, src/)
  - do NOT change assertion expected values
  - do NOT add pytest.mark.skip / xfail
  - do NOT delete failing tests
  - do NOT apply high risk proposals (risk_level == high → skipped_proposals)
  - patch_plan[].file MUST be in files_to_modify before any patch applied
  - files_to_modify MUST be in trusted source (workflow-state or codegen-summary)
  - do NOT set phases.healing.status = applied (orchestrator's job)
```

### Phase 11B — E2E Codegen Fix *(healing)*

```yaml
inputs:
  - healing/fix-proposal.json           (proposals with target==e2e, eligible==true, risk_level in [low, medium])
  - workflow-state.yaml                  (phases.healing.status must be proposal_created)
  - inspect/failure-analysis.json
  - codegen/e2e-codegen-summary.md       (trusted source for allowed files)
outputs:
  - tests/e2e/test_<module>_e2e.py       (modified — only if proposal targets it)
  - healing/e2e-apply-summary.json       (required)
  - healing/e2e-apply-summary.md         (required)
  - healing/e2e-fixer-error.json         (written only on hard error)
  - workflow-state.yaml (updated: attempts[n].e2e_apply_status = applied | no_op | failed)
rules:
  - same as Phase 11A (with e2e-specific allowed file patterns)
  - do NOT set phases.healing.status = applied (orchestrator's job)
```

### Phase 12 — Re-run *(healing)*

```yaml
inputs:
  - workflow-state.yaml
  - modified test files
outputs:
  - execution/runs/<new-batch-id>/   (full run archive)
  - execution/execution-manifest.yaml (updated, latest pointer)
  - workflow-state.yaml (updated: phases.execution.status, phases.healing.attempts[n].rerun_batch_id)
```

### Phase 13 — Re-inspect *(healing)*

```yaml
inputs:
  - workflow-state.yaml
  - execution/execution-manifest.yaml  (updated by Phase 12 — must have new batch_id)
  - selected result files (per manifest.selected_targets)
outputs:
  - inspect/failure-analysis.json   (updated, source of truth; must include source_batch_id)
  - inspect/failure-summary.md      (updated)
  - inspect/inspect-safety-check.json  (evidence file from Inspect Safety Gate)
  - workflow-state.yaml (updated: phases.inspect.status, phases.healing.attempts[n].result,
                         phases.healing.attempts[n].reinspect_batch_id)
gate:
  - inspect/failure-analysis.json.source_batch_id MUST equal phases.execution.batch_id
    (re-inspect must be based on the Phase 12 re-run batch, not a prior batch)
  - if final_status in [PASS, PASS_WITH_WARNINGS]:
      phases.healing.status = resolved → exit healing loop → advance to Phase 14
  - if final_status == FAIL and healing.attempts < max_healing_attempts and eligible failures remain:
      → loop to Phase 10
  - if healing.attempts exhausted → phases.healing.status = exhausted → STOP
```

### Phase 14 — Archive

```yaml
inputs:
  - workflow-state.yaml
  - review/case-review.json (decision == "pass")
  - review/api-plan-review.json (if api tested)
  - review/plan-review.json (if e2e tested)
  - execution/api-result.json (only if manifest.selected_targets.api == true)
  - execution/e2e-result.json (only if manifest.selected_targets.e2e == true)
  - execution/summary.md
  - execution/execution-manifest.yaml
  - execution/known-product-issues.md (if present)
  - inspect/known-product-issues.md (if present)
outputs:
  - qa/cases/<module>/case.yaml (merged)
  - qa/archive/<change-id>/  (all process artifacts copied)
  - workflow-state.yaml (updated: phases.archive.status = archived | archived_with_warnings)
gate:
  - user explicitly requests archive, or auto_archive == true
  - all applicable review JSON files have decision == "pass"
  - phases.execution.status in [PASS, PASS_WITH_WARNINGS]  — NEVER archive when FAIL
  - phases.healing.status in [not_needed, resolved, skipped] — NEVER archive when applied/exhausted/failed
    NOTE: "applied" alone is NOT sufficient — rerun + re-inspect (Phase 12+13) must complete (→ resolved)
    NOTE: skipped is archive-eligible ONLY when phases.execution.status in [PASS, PASS_WITH_WARNINGS]
          (the execution gate above already enforces this, but the constraint is stated explicitly here)
  - inspect/failure-analysis.json.source_batch_id == phases.execution.batch_id
    (latest inspect must be based on latest execution batch, not a stale earlier run)
  - no unresolved fix_proposal_eligible failures in latest inspect/failure-analysis.json
  - inspect/inspect-safety-check.json exists AND passed == true for latest inspect phase
    (Phase 9 for no-healing path; Phase 13 for healing path)
  - if phases.healing.status == resolved:
      healing/fixer-safety-check.json exists AND passed == true
  - if phases.execution.status == PASS_WITH_WARNINGS caused by known product issues:
      require phases.inspect.status in [done, partial]
      known product issues must be explicitly listed and acknowledged
  - if phases.execution.status == PASS_WITH_WARNINGS caused by fallback runner (no standard result files):
      require human confirmation OR explicit runtime parameter auto_archive_with_fallback == true
      do NOT auto-archive fallback pass as formal regression assets when auto_archive == true alone
  - if known product issues exist, require phases.inspect.status in [done, partial]
never_archive_when:
  - phases.execution.status == FAIL
  - phases.healing.status == applied    # applied means fixer ran but rerun/re-inspect not yet done
  - phases.healing.status == exhausted
  - phases.healing.status == failed
  - inspect/failure-analysis.json.source_batch_id != phases.execution.batch_id  (stale inspect)
  - inspect/failure-analysis.json contains unresolved fix_proposal_eligible failures
```

---

## Full Workflow (run_mode = full)

All phases execute **inline in the primary agent**. No subagents or tasks are used.

After every phase that writes artifacts or updates `workflow-state.yaml`, apply the **Phase Completion Rule** above, including the shadow-mode CLI calls (`aws status` always; `aws gate check` when the phase has a schema gate). The prose workflow remains authoritative during shadow mode; CLI disagreements are recorded, not used to override routing.

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

Phase 3.5 — Fact Baseline (always runs after Case Review passes)
  → Read seed/init sources: look for app/core/init_app.py, db/seed*.py, fixtures/, or equivalent
  → If live DB probe is configured (.aws/config.yaml has db_probe: true): run read-only probe
  → Capture: built-in role id/name, auth credentials, route prefix, token header mechanism
  → Write facts/fact-baseline.json
  → Update workflow-state.yaml: phases.fact_baseline.status = done

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
  → Re-read from disk: workflow-state.yaml, api-plan.md, api-codegen-plan.md, api-plan-review.json, .aws/data-knowledge.yaml
  → Apply Codegen Hard Gates (API) — force_continue MUST NOT bypass
  → Execute inline   ← MUST be inline in primary agent; DO NOT delegate to subagent or background task
  → Verify files listed in api-codegen-plan.md Target Files exist (helpers/fixtures/conftest only if plan authorized)
  → Verify codegen/api-codegen-summary.md exists
  → Update workflow-state.yaml: phases.api_codegen (review_gate_file, codegen_readiness, generated_tests.files, warnings_carried)

[E2E branch — run if test_types includes "e2e"]

Phase 4B — E2E Plan
  → Load skill aws-e2e-plan in primary agent
  → Re-read from disk: workflow-state.yaml, proposal.md, case.yaml
  → Execute inline
  → Verify e2e-plan.md, e2e-test-data-plan.md, e2e-codegen-plan.md exist on disk
  → Update workflow-state.yaml: phases.e2e_plan.status = done

Phase 5B — E2E Plan Review (initial)
  → Load skill aws-e2e-plan-reviewer in primary agent
  → Re-read from disk: workflow-state.yaml, e2e-plan.md, e2e-test-data-plan.md, e2e-codegen-plan.md
  → Execute inline
  → Read plan-review.json from disk
  → Apply plan review gate
  → Update workflow-state.yaml: phases.e2e_plan_review.status

Phase 6B — E2E Plan Fix Loop (if gate requires it)
  → For each attempt (max = max_plan_fix_attempts):
      → Load skill aws-e2e-plan-fixer in primary agent
      → Re-read from disk: plan-review.json, e2e-plan.md
      → Execute inline
      → Load skill aws-e2e-plan-reviewer in primary agent
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
  → Re-read from disk: workflow-state.yaml, e2e-plan.md, e2e-codegen-plan.md, plan-review.json, .aws/data-knowledge.yaml
  → Apply Codegen Hard Gates (E2E) — force_continue MUST NOT bypass
  → Execute inline   ← MUST be inline in primary agent; DO NOT delegate to subagent or background task
  → Verify files listed in e2e-codegen-plan.md Target Files exist (scripts/fixtures/conftest only if plan authorized)
  → Verify codegen/e2e-codegen-summary.md exists
  → E2E framework: runtime `e2e_framework=python-playwright` → workflow-state `generated_tests.framework=pytest-playwright`
  → Do NOT generate *.spec.ts files
  → Update workflow-state.yaml: phases.e2e_codegen (review_gate_file, codegen_readiness, generated_tests.files, data_setup, fixtures, warnings_carried)

Phase 7 Completion Gate — verify before Phase 8
  → If test_types includes "api":
      - phases.api_codegen.status MUST == done  (not stopped, not failed, not pending)
      - codegen/api-codegen-summary.md MUST exist on disk
      - All Target Files from api-codegen-plan.md MUST exist on disk
      - If any condition fails: STOP — report which codegen output is missing
  → If test_types includes "e2e":
      - phases.e2e_codegen.status MUST == done
      - codegen/e2e-codegen-summary.md MUST exist on disk
      - All Target Files from e2e-codegen-plan.md MUST exist on disk
      - If any condition fails: STOP — report which codegen output is missing
  → If run_tests == false: skip Phase 8, record phases.execution.status = SKIPPED, advance to Phase 14 gate

Phase 8 — Test Execution (run_tests = true; MUST execute if Phase 7 gate passed)
  → If run_tests == true and Phase 7 Completion Gate passed: this phase is MANDATORY — skipping it is a STOP condition
  → Load skill aws-run in primary agent
  → Re-read from disk: workflow-state.yaml, .aws/config.yaml
  → Execute inline: aws-run must attempt `aws run --change <change-id>` first (primary mode)
  → Direct pytest fallback is controlled only by aws-run Runner Mode:
      - allowed only when .aws/config.yaml has allow_direct_pytest_fallback: true
      - or user explicitly accepts fallback risk
      - fallback pass → final_status MUST be PASS_WITH_WARNINGS, never PASS
      - no fallback allowed + CLI missing → final_status MUST be FAIL
  → Verify execution/execution-manifest.yaml exists on disk after run
      - If missing after run: STOP — do not report execution as complete
  → Read final_status from execution/execution-manifest.yaml (not from chat or claim)
  → Update workflow-state.yaml: phases.execution.status = final_status, phases.execution.batch_id
  → If run_tests == true but this phase is not reached: workflow status MUST be stopped, not completed

Phase 9 — Inspect / Failure Analysis
  → Load skill aws-inspect if: phases.execution.status in [FAIL, PASS_WITH_WARNINGS]
      OR qa/changes/<change-id>/known-product-issues.md exists
      OR qa/changes/<change-id>/execution/known-product-issues.md exists
  → Re-read from disk: workflow-state.yaml, execution/execution-manifest.yaml (required)
  → If execution-manifest.yaml missing: STOP, ask user to re-run aws-run
  → Re-read result files only for selected targets (per manifest.selected_targets)
  → Execute inline
  → Primary outputs land in inspect/ (source of truth); execution/ gets optional copies
  → Update workflow-state.yaml: phases.inspect.status = done (primary) or partial (fallback); inspect_mode = primary | partial; classification_performed = true | false
  → Apply Status Update Rules: only PASS→PASS_WITH_WARNINGS allowed, never degrade FAIL
  → Output structured summary (see Final Response Format)
  → Report agent_warnings from workflow-state.yaml
  → Load skill aws-dashboard if run_dashboard = true

  → Apply Inspect Safety Gate (see Inspect Safety Gate section)
      If any forbidden file was modified by inspect: STOP

  → Evaluate healing entry conditions:
      If phases.execution.status in [PASS, PASS_WITH_WARNINGS] AND no fix_proposal_eligible failures:
        Set phases.healing.status = not_needed
        → Proceed to Phase 14 archive gate
      If phases.execution.status == FAIL AND no fix_proposal_eligible failures:
        Set phases.healing.status = not_needed
        → STOP: no eligible auto-fix; require human intervention
      If phases.execution.status == FAIL AND fix_proposal_eligible failures exist:
        If gates.healing_available == false: STOP — report healing skills unavailable
        If phases.inspect.inspect_mode != primary: STOP — healing requires primary inspect mode
        → Enter healing loop (Phase 10)

[Healing loop — Phases 10–13]

Phase 10 — Fix Proposal
  → Load skill aws-fix-proposal in primary agent   ← MUST be inline in primary agent
  → Re-read from disk: workflow-state.yaml, inspect/failure-analysis.json (required), inspect/failure-summary.md, execution/execution-manifest.yaml
  → Execute inline
  → Verify healing/fix-proposal.json exists and is valid JSON
  → Verify healing/fix-proposal.md exists
  → If fix-proposal.json.summary.eligible_count == 0:
      Set phases.healing.status = not_needed
      If phases.execution.status == FAIL: STOP — no eligible fixes; require human intervention
  → Update workflow-state.yaml: phases.healing.status = proposal_created
  → IMMEDIATELY allocate attempt index n and write attempt entry BEFORE Phase 11 starts:
      phases.healing.attempts[n]:
        attempt: <n>
        proposal_file: healing/fix-proposal.md
        proposal_json: healing/fix-proposal.json
        eligible_failures: [<ids from fix-proposal.json>]
        api_apply_status: pending
        e2e_apply_status: pending
        result: pending
      This attempt counts toward max_healing_attempts even if Phase 11/12/13 subsequently fail.

Phase 11 — Apply Fixes
  [If fix-proposal.json contains API proposals (target == "api" AND eligible == true):]
  → Load skill aws-api-codegen-fixer in primary agent   ← MUST be inline in primary agent
  → Re-read from disk: workflow-state.yaml, healing/fix-proposal.json, inspect/failure-analysis.json
  → Execute inline
  → Verify healing/api-apply-summary.json exists and is valid JSON
  → Verify every file in api-apply-summary.json.modified_files is an allowed API test file
  → If healing/api-fixer-error.json was written: STOP — forbidden modification attempted

  [If fix-proposal.json contains E2E proposals (target == "e2e" AND eligible == true):]
  → Load skill aws-e2e-codegen-fixer in primary agent   ← MUST be inline in primary agent
  → Re-read from disk: workflow-state.yaml, healing/fix-proposal.json, inspect/failure-analysis.json
  → Execute inline
  → Verify healing/e2e-apply-summary.json exists and is valid JSON
  → Verify every file in e2e-apply-summary.json.modified_files is an allowed E2E test file
  → If healing/e2e-fixer-error.json was written: STOP — forbidden modification attempted

  → Apply Fixer Safety Gate (see Fixer Safety Gate section)
      If product code changed, assertions weakened, tests deleted, skip/xfail added, or unrelated tests changed:
        STOP — do NOT proceed to Phase 12

  → Orchestrator sets global apply status (after BOTH fixers complete and safety gate passes):
      Read api_apply_status from attempt entry (applied | no_op | failed)
      Read e2e_apply_status from attempt entry (applied | no_op | failed)

      If any status == failed:
        → phases.healing.status = failed; STOP

      If ALL statuses == no_op (no fixer applied any change):
        → STOP: eligible proposals existed in fix-proposal.json but no fixer applied any change
        → reason: "eligible proposals listed but all fixers returned no_op — likely a proposal/file authorization mismatch"
        → phases.healing.status = failed
        → Do NOT proceed to Phase 12 rerun (running unchanged code again is meaningless)

      If all statuses are in [applied, no_op] AND at least one status == applied:
        → phases.healing.status = applied
        → Update workflow-state.yaml: phases.healing.attempts[n].applied_files (aggregate from both fixers)

Phase 12 — Re-run
  → Load skill aws-run in primary agent   ← MUST be inline in primary agent
  → Re-read from disk: workflow-state.yaml, .aws/config.yaml
  → Execute inline: attempt `aws run --change <change-id>` (primary mode)
  → Verify execution/runs/<new-batch-id>/ was created (new batch, different from Phase 8 batch)
  → Verify execution/execution-manifest.yaml was updated with new batch_id
  → Read final_status from updated execution/execution-manifest.yaml (not from chat or claim)
  → Update workflow-state.yaml:
      phases.execution.status = final_status
      phases.healing.attempts[n].rerun_batch_id = <new-batch-id>
  → If execution-manifest.yaml not updated with a new batch: STOP — do not claim rerun completed

Phase 13 — Re-inspect
  → Load skill aws-inspect in primary agent   ← MUST be inline in primary agent
  → Re-read from disk: workflow-state.yaml, execution/execution-manifest.yaml (updated in Phase 12)
  → Execute inline
  → Verify inspect/failure-analysis.json was updated:
      - Read inspect/failure-analysis.json.source_batch_id
      - Verify source_batch_id == phases.execution.batch_id (from latest execution-manifest.yaml)
      - If mismatch: STOP — re-inspect analyzed a stale batch, not the Phase 12 re-run
  → Verify inspect/failure-summary.md was updated
  → Update workflow-state.yaml:
      phases.inspect.status
      phases.healing.attempts[n].result = final_status
      phases.healing.attempts[n].reinspect_batch_id = source_batch_id from failure-analysis.json

  → Apply Inspect Safety Gate (same rules as Phase 9 safety gate)

  → Apply healing loop gate:
      If phases.execution.status in [PASS, PASS_WITH_WARNINGS]:
        → Set phases.healing.status = resolved
        → Update attempt entry: phases.healing.attempts[n].result = PASS or PASS_WITH_WARNINGS
        → Exit healing loop — proceed to Phase 14 archive gate
      If phases.execution.status == FAIL AND healing.attempts < max_healing_attempts AND fix_proposal_eligible failures remain:
        → Update attempt entry: phases.healing.attempts[n].result = FAIL
        → Increment healing attempt counter
        → Loop back to Phase 10 (re-read files from disk first)
      If healing.attempts exhausted (count == max_healing_attempts):
        → Set phases.healing.status = exhausted
        → Update attempt entry: phases.healing.attempts[n].result = FAIL
        → STOP: healing attempts exhausted; require human intervention
        → Do NOT proceed to archive

Phase 14 — Archive (only when user explicitly requests OR auto_archive == true)
  → Verify archive gate before loading skill:
      - phases.execution.status in [PASS, PASS_WITH_WARNINGS] — if FAIL: STOP
      - phases.healing.status in [not_needed, resolved, skipped] — if applied/exhausted/failed: STOP
        ("applied" alone is NOT sufficient — healing must have completed Phase 12+13 to reach "resolved")
        ("skipped" is only archive-eligible when execution.status in [PASS, PASS_WITH_WARNINGS])
      - inspect/failure-analysis.json.source_batch_id == phases.execution.batch_id — if stale: STOP
      - no unresolved fix_proposal_eligible failures in latest inspect/failure-analysis.json
      - inspect/inspect-safety-check.json exists and passed == true (latest phase) — if missing or failed: STOP
      - if phases.healing.status == resolved: healing/fixer-safety-check.json exists and passed == true — if not: STOP
      - if PASS_WITH_WARNINGS from known product issues: require phases.inspect.status in [done, partial]; issues explicitly acknowledged
      - if PASS_WITH_WARNINGS from fallback runner: require human confirmation OR auto_archive_with_fallback == true
      - all applicable review JSON files have decision == "pass"
  → Load skill aws-archive in primary agent
  → Re-read from disk: workflow-state.yaml, review JSON files, execution result files
  → Execute inline
  → Archive case delta into qa/cases/, copy artifacts to qa/archive/<change-id>/
  → Update workflow-state.yaml: phases.archive.status = archived | archived_with_warnings
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

### Fact Baseline outputs (Phase 3.5)

```text
qa/changes/<change-id>/facts/fact-baseline.json
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

Only files listed in `api-codegen-plan.md` Target Files (helpers / fixtures / conftest are optional per plan):

```text
qa/changes/<change-id>/codegen/api-codegen-summary.md   ← always
tests/api/test_<module>_api.py                          ← when mapped in Target Files
tests/api/helpers/<module>_api.py                       ← only if plan helper mapping non-empty
tests/fixtures/<module>_fixtures.py                     ← only if plan + data-knowledge authorize
tests/api/conftest.py                                   ← only if plan explicitly requires
```

Note: execution result files are written by `aws-run` in Phase 8, not by `aws-api-codegen`.

### E2E Codegen outputs

Only files listed in `e2e-codegen-plan.md` Target Files (scripts / fixtures / conftest are optional per plan):

E2E framework: **Python Playwright** — default naming `tests/e2e/test_<module>_e2e.py` (NOT `*.spec.ts`).

```text
qa/changes/<change-id>/codegen/e2e-codegen-summary.md   ← always
tests/e2e/test_<module>_e2e.py                          ← when mapped in Target Files
tests/e2e/scripts/<module>_data_setup.py                ← only if plan + data-knowledge authorize
tests/fixtures/**/*.py                                  ← only if plan + data-knowledge authorize
tests/e2e/conftest.py                                   ← only if plan explicitly requires
```

Note: execution result files are written by `aws-run` in Phase 8, not by `aws-e2e-codegen`.

### Execution outputs (written by aws-run, Phase 8)

```text
qa/changes/<change-id>/execution/api-result.json              ← only if manifest.selected_targets.api == true
qa/changes/<change-id>/execution/e2e-result.json              ← only if manifest.selected_targets.e2e == true
qa/changes/<change-id>/execution/summary.md                   ← always required in primary mode
qa/changes/<change-id>/execution/execution-manifest.yaml      ← always present
qa/changes/<change-id>/execution/known-product-issues.md      ← snapshot from change-level record (if present)
qa/changes/<change-id>/execution/runs/<batch-id>/             ← per-run archive (never overwritten)
```

Do not fail because an unselected target result file is absent.

### Inspect outputs (written by aws-inspect, Phase 9)

```text
qa/changes/<change-id>/inspect/failure-analysis.json          ← primary mode only (source of truth)
qa/changes/<change-id>/inspect/failure-summary.md             ← source of truth
qa/changes/<change-id>/inspect/inspection-partial.json        ← partial mode only
qa/changes/<change-id>/inspect/known-product-issues.md        ← if known issues found or confirmed
qa/changes/<change-id>/inspect/inspection-error.json          ← if primary CLI failed / outputs missing

qa/changes/<change-id>/execution/failure-analysis.json        ← optional copy/pointer (primary mode)
qa/changes/<change-id>/execution/failure-summary.md           ← optional copy/pointer
```

**Inspect mode (`phases.inspect.inspect_mode`):**

| Value | `classification_performed` | Key outputs |
|-------|---------------------------|-------------|
| `primary` | `true` | `failure-analysis.json` |
| `partial` | `false` | `inspection-partial.json` |

Healing loop (Phases 10–13) requires `inspect_mode == primary` and `inspect/failure-analysis.json`.

**Directory semantics:**

- `execution/` — runner products: result JSON, manifest, known-product-issues snapshot
- `inspect/` — analysis products: failure classification, summaries, known-issue confirmations

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

### Fact Baseline Gate (before Phase 5A / 5B — Plan Review)

Before running `aws-api-plan-reviewer` (Phase 5A) or `aws-e2e-plan-reviewer` (Phase 5B), verify:

- `facts/fact-baseline.json` exists
- If `source != "unavailable"`: key facts (role names/ids, auth credentials, route prefix, token header) in the plan documents **must match** values in `fact-baseline.json`
  - If mismatch found: mark the plan review as **blocked** and set `phases.api_plan_review.status = stale` (or `e2e_plan_review`) with `reason: fact_mismatch_before_review`
  - Correct the plan documents first, then run the reviewer
- If `source == "unavailable"`: log a warning but do not block; reviewer proceeds with a `fact_validation_skipped: true` note in the review JSON

This gate prevents review-JSON artifacts from being written against stale facts, avoiding the full-chain contamination described in P0-4.

---

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

- `decision == "pass"` and `codegen_readiness in ["ready","ready_with_warnings"]` and `blockers` empty and no blocking `needs_review` → continue to `aws-api-codegen` (also requires `.aws/data-knowledge.yaml` — see Codegen Hard Gates)
- `decision == "reject"` → STOP
- `human_review_required == true` and `force_continue == false` → STOP
- `risk_level in ["high","critical"]` and `force_continue == false` → STOP
- `codegen_readiness == "not_ready"` → STOP (**force_continue MUST NOT bypass**)
- `blockers` non-empty → STOP (**force_continue MUST NOT bypass**)
- any `needs_review` item with `blocking == true` → STOP (**force_continue MUST NOT bypass**)
- `decision == "needs_fix"` and `auto_fix_allowed == true` and `next_action == "run_api_plan_fixer"` → run `aws-api-plan-fixer`
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
  "next_action": "continue|run_e2e_plan_fixer|human_review|stop",
  "created_at": "YYYY-MM-DDTHH:mm:ssZ"
}
```

Gate decision:

- `decision == "pass"` and `codegen_readiness in ["ready","ready_with_warnings"]` and `blockers` empty and no blocking `needs_review` → continue to `aws-e2e-codegen` (also requires `.aws/data-knowledge.yaml` — see Codegen Hard Gates)
- `decision == "reject"` → STOP
- `human_review_required == true` and `force_continue == false` → STOP
- `risk_level in ["high","critical"]` and `force_continue == false` → STOP
- `codegen_readiness == "not_ready"` → STOP (**force_continue MUST NOT bypass**)
- `blockers` non-empty → STOP (**force_continue MUST NOT bypass**)
- any `needs_review` item with `blocking == true` → STOP (**force_continue MUST NOT bypass**)
- `decision == "needs_fix"` and `auto_fix_allowed == true` and `next_action == "run_e2e_plan_fixer"` → run `aws-e2e-plan-fixer`
- otherwise → STOP

---

## force_continue Boundaries

`force_continue` may **only** bypass:

- `human_review_required == true`
- `risk_level in ["high", "critical"]`

`force_continue` **MUST NOT** bypass:

- missing required review JSON
- invalid review JSON
- `decision != "pass"` for codegen entry
- `codegen_readiness == "not_ready"`
- `blockers` non-empty
- any `needs_review` item with `blocking == true`
- missing `.aws/data-knowledge.yaml` before codegen
- missing required phase output files

---

## Fact Correction Mode

Fact Correction Mode activates when a **newly discovered source-of-truth fact** (from live DB probe, seed file re-read, or code inspection) invalidates artifacts that were produced in earlier phases — including artifacts that already passed review.

### When to Activate

Activate Fact Correction Mode if ANY of the following is true after Phase 4 or later:

- A role name / id in `proposal.md`, `case.yaml`, or plan files does not match `facts/fact-baseline.json`
- Auth credentials, route prefix, or token header in plan files differ from seed source
- A live DB probe returns data that contradicts an assumption embedded in approved plans

### What Fact Correction Mode Allows

- **Modify** `proposal.md`, `cases/<module>/case.yaml`, `plans/api-plan.md`, `plans/e2e-plan.md`, and generated test files — but ONLY for the discovered fact, no scope creep
- **NOT** allowed to add new test cases or change test logic beyond the fact correction

### Required Actions

1. **Mark affected review gates as stale** in `workflow-state.yaml` before making any edits:

   ```yaml
   phases:
     api_plan_review:
       status: stale
       stale_reason: fact_correction_after_review
     e2e_plan_review:
       status: stale
       stale_reason: fact_correction_after_review
     api_codegen:
       status: needs_patch
       needs_patch_reason: stale_role_name_fact
       generated_tests:
         semantic_validity: stale
   ```

2. **Apply corrections** to plan files and generated test files.

3. **Write `facts/fact-correction-summary.json`**:

   ```json
   {
     "change_id": "<change-id>",
     "triggered_at": "Phase 7B codegen pre-check",
     "discovered_at": "<ISO timestamp>",
     "discovery_source": "live_db_probe | seed_file | code_inspection",
     "corrections": [
       {
         "artifact": "plans/api-plan.md",
         "field": "role.name",
         "stale_value": "admin",
         "correct_value": "管理员",
         "files_patched": ["tests/api/test_role_api.py"]
       }
     ],
     "stale_gates": ["api_plan_review", "e2e_plan_review"],
     "stale_codegen": ["api_codegen"],
     "re_review_required": ["api_plan_review", "e2e_plan_review"]
   }
   ```

4. **Re-run affected reviewers** (`aws-api-plan-reviewer`, `aws-e2e-plan-reviewer`) to produce fresh review JSON.

5. **Re-collect** any patched test files: `pytest --collect-only <patched_test_file>` — collect-only confirms syntax, not semantics.

6. **Update `workflow-state.yaml`** after re-review passes:

   ```yaml
   phases:
     api_plan_review:
       status: pass
       stale_reason: null
     api_codegen:
       status: needs_patch   # remains until Phase 8 execution confirms semantics
       generated_tests:
         semantic_validity: stale   # updated to valid only after Phase 8 PASS
   ```

### Fact Correction Mode Is NOT a Substitute for Standard Fixers

`aws-api-plan-fixer` and `aws-e2e-plan-fixer` require `decision == needs_fix` in the review JSON. Fact Correction Mode handles a different case: `decision == pass` but the review is **stale** due to a fact discovered after review. These are separate flows:

| Situation | Mechanism |
|---|---|
| Review says `needs_fix` | Standard fixer (`aws-api-plan-fixer`) |
| Review is `pass` but facts changed | Fact Correction Mode (inline patch + re-review) |
| Codegen artifact contains stale facts | Set `needs_patch`, patch inline, re-collect, re-review |

---

## Codegen Hard Gates

Before **Phase 7A (API Codegen)** or **Phase 7B (E2E Codegen)**, verify in order — **STOP** on first failure. **`force_continue` MUST NOT bypass any item below.**

### API Codegen (Phase 7A)

Read `review/api-plan-review.json` and verify:

- valid JSON; `review_type == "api-plan"`; `change_id == <change-id>`
- `decision == "pass"`
- `codegen_readiness in ["ready", "ready_with_warnings"]`
- `blockers` is empty
- no `needs_review` item has `blocking == true`
- `.aws/data-knowledge.yaml` exists on disk
- required plan files exist (`api-plan.md`, `api-test-data-plan.md`, `api-codegen-plan.md`, `m3-review-summary.md`)

### E2E Codegen (Phase 7B)

Read `review/plan-review.json` and verify:

- valid JSON; `review_type == "e2e-plan"`; `change_id == <change-id>`
- `decision == "pass"`
- `codegen_readiness in ["ready", "ready_with_warnings"]`
- `blockers` is empty
- no `needs_review` item has `blocking == true`
- `.aws/data-knowledge.yaml` exists on disk
- required plan files exist (`e2e-plan.md`, `e2e-test-data-plan.md`, `e2e-codegen-plan.md`, `m4-review-summary.md`)

---

## User Approval Is Not a Gate Artifact

Natural language approval from the user is **not** sufficient to advance to codegen or archive.

If the user manually approves a plan, the corresponding reviewer must still write the review JSON file recording that approval:

- User approves case artifacts → `aws-case-reviewer` must write `case-review.json`
- User approves API plan → `aws-api-plan-reviewer` must write `api-plan-review.json`
- User approves E2E plan → `aws-e2e-plan-reviewer` must write `plan-review.json`

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

## When to Ask the User

**Do NOT ask the user to choose phase execution order.** The workflow routing table defines the sequence (Phase 4A → 5A → 6A → 7A for API; Phase 4B → 5B → 6B → 7B for E2E). This is not a user decision.

**Do NOT ask** for:

- Whether to run Phase 7A before or after Phase 7B — workflow defines: API first, then E2E
- Which phases to run — determined by `test_types` in `.qa.yaml`
- Whether to proceed to the next phase after a `pass` — proceed automatically
- What fix approach to use when `auto_fix_allowed == true` — run the designated fixer

**DO ask** the user only in these cases:

| Situation | What to ask |
|---|---|
| `human_review_required == true` in any review JSON | Present findings, ask for decision |
| `risk_level in ["high", "critical"]` (without `force_continue`) | Present risk, ask to proceed or stop |
| Fact correction affects already-approved artifacts | Present the conflict, ask: in-place correction or rollback to planning |
| Fallback runner risk (aws-run not found, test framework missing) | Present alternatives |
| Archive confirmation when `auto_archive == false` | Ask before archiving |
| Healing exhausted, still FAIL | Ask: accept failures, re-plan, or stop |

Any decision not in this list is made by the workflow itself. Do not surface it as a user question.

---

## Document-driven Parallel Work Does Not Bypass the Gate

This workflow uses inline orchestration — it does not launch skill-loading subagents. The only permitted form of parallel work is **document-driven**: a subagent receives a plan document as input and executes it directly, without loading skills.

If optional document-driven parallel work fails or is unavailable, the workflow may continue inline only when the same required artifacts are produced:

- Parallel work fails → inline reviewer may generate the review JSON.
- Parallel work fails → you may **not** skip review and proceed directly to codegen or archive.

Every gate listed in **Mandatory Review JSON Gate** applies identically whether the phase ran as parallel document-driven work or fully inline.

---

## Subagent Usage Disambiguation

This section clarifies when subagent usage is **allowed** vs. **forbidden**, and how to record it unambiguously in `workflow-state.yaml`.

### Allowed: exploration / document-driven subagents

```text
✅ explore agent reads backend source files
✅ explore agent reads frontend directory structure
✅ document-driven subagent receives plan.md and produces a non-gate artifact
```

These do **not** constitute a forbidden-pattern violation. However, they **must be recorded**:

```yaml
subagents:
  used: true
  purpose:
    - source_exploration_only        # if used for codebase exploration
    - document_driven_parallel       # if used for parallel document work
  loaded_skills: false               # MUST remain false
  attempted_skill_loading: false     # MUST remain false
  attempted_phase_execution: false   # MUST remain false
  affected_gates: false              # MUST remain false
```

### Forbidden: skill-loading or gate-producing subagents

```text
❌ subagent is asked to load aws-case-design
❌ subagent writes case-review.json
❌ subagent writes api-plan-review.json
❌ subagent produces any gate artifact substituting for an inline reviewer
```

If either of these occurs, set the corresponding flag and **STOP**:

```yaml
subagents:
  used: true
  loaded_skills: true              # forbidden — subagent successfully loaded an AWS skill
  attempted_skill_loading: true    # forbidden — subagent attempted skill loading
  attempted_phase_execution: true  # forbidden — subagent was used to execute a phase
  affected_gates: true             # forbidden — subagent produced or substituted a gate artifact
```

### Forbidden: codegen subagents

API/E2E codegen **MUST NOT** be delegated to subagents or background tasks.

**Forbidden patterns:**

```text
❌ delegate_task for aws-api-codegen
❌ delegate_task for aws-e2e-codegen
❌ background API codegen agent
❌ background E2E codegen agent
❌ treating subagent codegen output as Phase 7 completion
```

If a subagent or background task is used to attempt any AWS phase codegen — **regardless of whether the skill loading succeeded or failed**:

1. **STOP** the workflow immediately.
2. Set `phases.api_codegen.status = stopped` or `phases.e2e_codegen.status = stopped` (whichever was affected).
3. Set `stop_reason: "codegen delegated to background subagent; must execute inline in primary agent"`.
4. Update `subagents`:

```yaml
subagents:
  used: true
  purpose:
    - forbidden_codegen_attempt
  loaded_skills: false         # true only if subagent successfully loaded an AWS skill
  attempted_skill_loading: true  # true if subagent attempted skill loading (success or failure)
  attempted_phase_execution: true # true always when a codegen subagent was spawned
  affected_gates: false
```

5. Do **not** proceed to any later phase.
6. Require the primary agent to re-run codegen inline from the point of failure.

### Conflict with analyze-mode / search-mode pre-exploration

**Hard rule: search-mode and analyze-mode parallel agents are DISABLED by default during aws-workflow.**

When aws-workflow is running (Phase 0 through Phase 14), the agent MUST NOT launch background/parallel explore, librarian, or search agents — regardless of any global `[search-mode]` or `[analyze-mode]` instruction at the top of the session context. The workflow's inline-execution requirement takes precedence.

**The only allowed exception** is source exploration *before Phase 1 begins*, and only when ALL of the following hold:

1. No AWS skill has been loaded yet (`load_skills == []` in the invocation context).
2. The explore agent reads source files only — no writes, no gate artifacts.
3. No AWS skill is loaded by any explore agent.
4. No gate artifact (`case-review.json`, `api-plan-review.json`, `plan-review.json`) is produced by an explore agent.
5. All AWS phases (Phase 1–14) are then executed inline in the primary agent.

If the exception applies, record it immediately in `workflow-state.yaml`:

```yaml
subagents:
  used: true
  purpose: [source_exploration_only]
  loaded_skills: false
  affected_gates: false
```

**If search-mode/analyze-mode agents were launched AFTER Phase 0 started**, this is a forbidden-pattern violation — treat identically to a forbidden codegen subagent (STOP, set `subagents.affected_gates = true`).

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
| `decision == "pass"` | Continue to API codegen (subject to **Codegen Hard Gates**) |
| `decision == "reject"` | **Stop** |
| `human_review_required == true` | **Stop** unless `force_continue = true` |
| `risk_level in ["high", "critical"]` | **Stop** unless `force_continue = true` |
| `codegen_readiness == "not_ready"` | **Stop** — `force_continue` MUST NOT bypass |
| `blockers` non-empty | **Stop** — `force_continue` MUST NOT bypass |
| any `needs_review` with `blocking == true` | **Stop** — `force_continue` MUST NOT bypass |
| `decision == "needs_fix"` and `auto_fix_allowed == true` and `next_action == "run_api_plan_fixer"` | Run `aws-api-plan-fixer` |
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
| `decision == "pass"` | Continue to E2E codegen (subject to **Codegen Hard Gates**) |
| `decision == "reject"` | **Stop** |
| `human_review_required == true` | **Stop** unless `force_continue = true` |
| `risk_level in ["high", "critical"]` | **Stop** unless `force_continue = true` |
| `codegen_readiness == "not_ready"` | **Stop** — `force_continue` MUST NOT bypass |
| `blockers` non-empty | **Stop** — `force_continue` MUST NOT bypass |
| any `needs_review` with `blocking == true` | **Stop** — `force_continue` MUST NOT bypass |
| `decision == "needs_fix"` and `auto_fix_allowed == true` and `next_action == "run_e2e_plan_fixer"` | Run `aws-e2e-plan-fixer` |
| Any other condition | **Stop** and ask for human review |

**E2E plan review retry policy:**

- Initial E2E plan review does not count as a fix attempt.
- Max fix attempts: `max_plan_fix_attempts` (default 2).
- Max total E2E plan review runs: `max_plan_fix_attempts + 1` (default 3).
- If fix attempts are exhausted and decision is still not `pass`, stop.

---

## Healing Execution Policy

`aws-inspect` is the **diagnosis** stage of healing, not the repair stage.

The healing loop is:

```
aws-run (Phase 8)
  → aws-inspect (Phase 9)
  → aws-fix-proposal (Phase 10)
  → aws-api-codegen-fixer / aws-e2e-codegen-fixer (Phase 11)
  → aws-run (Phase 12: Re-run)
  → aws-inspect (Phase 13: Re-inspect)
  → (repeat if still eligible failures and attempts < max)
  → aws-archive (Phase 14)
```

**Eligible failure categories (fix_proposal_eligible == true):**

- `locator_failure`
- `wait_strategy_failure`
- `test_code_error`
- `test_data_failure` *(conditional — only if test data generation can be fixed without changing product code or expected assertions)*

**Human or external fix required (not eligible for healing loop):**

- `environment_failure`
- `assertion_failure`
- `business_logic_failure`
- `case_semantic_failure`
- `known_product_issue`
- `coverage_gap`
- `product_bug`
- `unrelated_existing_failure`
- `unknown`

**Healing entry conditions (after Phase 9):**

```text
IF phases.execution.status == FAIL
   AND inspect/failure-analysis.json contains failures with fix_proposal_eligible == true:
   AND phases.inspect.inspect_mode == primary
   AND phases.inspect.classification_performed == true:

  IF gates.healing_available == true → enter Phase 10
  IF gates.healing_available == false → STOP: report healing skills unavailable; do not archive

IF no eligible failures exist (or all fix_proposal_eligible == false):
  Set phases.healing.status = not_needed
  IF phases.execution.status == FAIL → STOP: no auto-fix available; require human intervention
  IF phases.execution.status in [PASS, PASS_WITH_WARNINGS] → proceed to Phase 14 archive gate
```

**Healing hard rules:**

- **Never** change assertion expected values automatically.
- **Never** fix product bugs by changing tests.
- **Never** hide `known_product_issue` or `coverage_gap`.
- **Never** change `FAIL` to `PASS` without a successful re-run from `aws-run` that produces `final_status == PASS`.
- Every healing apply (Phase 11) must be followed by a re-run (Phase 12).
- Every re-run (Phase 12) must be followed by a re-inspect (Phase 13).
- **Never** allow a diagnostic probe from Phase 9/13 to count as an official re-run.
- **Never** allow `phases.execution.status` to change from `FAIL` to `PASS` unless Phase 12 `aws-run` produced a new batch with `final_status == PASS`.
- **Never** allow healing to modify product code (`app/`, `web/`, `src/`).
- **Never** allow healing to modify unrelated tests outside the current change scope.
- If the healing skills (`aws-fix-proposal`, `aws-api-codegen-fixer`, `aws-e2e-codegen-fixer`) are not installed (`gates.healing_available == false`):
  - Set `phases.healing.status = skipped`.
  - If `phases.execution.status == FAIL` and `fix_proposal_eligible` failures exist in `inspect/failure-analysis.json`: **STOP** — report missing healing skills; do not archive a failed execution.
  - If `phases.execution.status in [PASS, PASS_WITH_WARNINGS]`: healing may be skipped; proceed to Phase 14.
- Max healing attempts: controlled by `max_healing_attempts` (default: `2`).

**Healing attempt counting rules:**

```text
An attempt is STARTED when Phase 10 produces fix-proposal.json with eligible_count > 0.
  → The attempt index MUST be allocated in workflow-state.yaml BEFORE Phase 11 starts.
  → From this point forward, the attempt counts toward max_healing_attempts.
  → There is NO mechanism to "undo" an attempt allocation.

An attempt is COMPLETED only after Phase 13 (re-inspect) runs and sets attempt.result.

Attempt result values:
  - PASS | PASS_WITH_WARNINGS  → healed; exit loop; set phases.healing.status = resolved
  - FAIL                        → not healed; check if more attempts remain
  - failed                      → hard error; stop immediately regardless of remaining attempts

The attempt ALWAYS counts even if:
  - Phase 11 fixer fails (api-fixer-error.json / e2e-fixer-error.json written)
  - Fixer Safety Gate fails (fixer-safety-check.json passed == false)
  - Phase 12 rerun fails to produce a new batch
  - Phase 13 re-inspect detects stale batch analysis

In all hard-error cases:
  → Set attempt.result = failed
  → Set phases.healing.status = failed
  → STOP immediately — do not loop back to Phase 10

max_healing_attempts = 2 means at most two complete or attempted cycles of:
  Phase 10 (fix-proposal) → Phase 11 (fixer) → Phase 12 (rerun) → Phase 13 (re-inspect)
```

---

## Inspect Safety Gate

Apply this gate **after Phase 9 (initial inspect)** and **after Phase 13 (re-inspect)**:

```text
Inspect Safety Gate:

BEFORE aws-inspect runs (Phase 9 and Phase 13):
  Record a filesystem baseline — either:
  a) Run: git diff --name-only HEAD  (if repo is git-tracked)
  b) Or: snapshot mtime/hash of all files under tests/, app/, web/, src/, .aws/,
         qa/changes/<change-id>/cases/, plans/, review/, healing/,
         qa/changes/<change-id>/execution/execution-manifest.yaml,
         qa/changes/<change-id>/execution/known-product-issues.md

AFTER aws-inspect completes:
  Compare against baseline to detect any file changes.

  ALLOWED changes:
    qa/changes/<change-id>/inspect/**
    qa/changes/<change-id>/execution/failure-analysis.json   (optional copy)
    qa/changes/<change-id>/execution/failure-summary.md      (optional copy)
    qa/changes/<change-id>/inspect/diagnostic-probes.json
    qa/changes/<change-id>/inspect/inspect-safety-check.json  (this file itself)

  FORBIDDEN changes:
    tests/**
    app/**
    web/**
    src/**
    .aws/**
    qa/changes/<change-id>/cases/**
    qa/changes/<change-id>/plans/**
    qa/changes/<change-id>/review/**
    qa/changes/<change-id>/healing/**
    qa/changes/<change-id>/execution/execution-manifest.yaml
    qa/changes/<change-id>/execution/known-product-issues.md

WRITE evidence file — MANDATORY, regardless of outcome.
Writing this file is NOT optional. If the orchestrator cannot write it, treat as passed == false.

  qa/changes/<change-id>/inspect/inspect-safety-check.json:
  {
    "schema_version": "1.0",
    "change_id": "<change-id>",
    "phase": "phase-9 | phase-13",
    "source_batch_id": "<batch-id from latest execution-manifest.yaml>",
    "checked_at": "YYYY-MM-DDTHH:mm:ssZ",
    "forbidden_modified_files": [],
    "allowed_modified_files": [
      "qa/changes/<change-id>/inspect/failure-analysis.json"
    ],
    "passed": true
  }

IF passed == false OR file does not exist:
  → Set phases.inspect.status = failed
  → Set workflow_status = stopped
  → STOP immediately
  → Report which forbidden file was modified (or that the evidence file is missing)
  → Do NOT proceed to healing or archive
```

---

## Fixer Safety Gate

Apply this gate **after Phase 11 (apply fixes)**:

```text
Fixer Safety Gate:

After aws-api-codegen-fixer and/or aws-e2e-codegen-fixer complete, verify:

1. patch_plan/files_to_modify consistency:
   Every modified file is listed in fix-proposal.json.proposals[].files_to_modify.
   Every patch_plan[].file is also in files_to_modify.
   → If mismatch: violation = true

2. Trusted source authorization:
   Every modified file appears in at least one trusted source:
   - workflow-state.yaml phases.api_codegen.generated_tests.files (API)
   - workflow-state.yaml phases.e2e_codegen.generated_tests.files (E2E)
   - codegen/api-codegen-summary.md or e2e-codegen-summary.md generated/reused files
   → If not authorized: violation = true

3. No product code was modified:
   FORBIDDEN modified paths: app/**, web/**, src/**
   → If found: violation = true

4. No assertion expected values were changed:
   → If found: violation = true

5. No tests were deleted:
   → If found: violation = true

6. No pytest.mark.skip, xfail, or equivalent was added:
   → If found: violation = true

7. No unrelated test files (outside change scope) were modified:
   → If found: violation = true

8. No high-risk proposal was applied (high risk → must appear in skipped_proposals, not applied_proposals):
   → If found in applied_proposals: violation = true

WRITE evidence file — MANDATORY, regardless of outcome.
Writing this file is NOT optional. If the orchestrator cannot write it, treat as passed == false.

  qa/changes/<change-id>/healing/fixer-safety-check.json:
  {
    "schema_version": "1.0",
    "change_id": "<change-id>",
    "attempt": <n>,
    "checked_at": "YYYY-MM-DDTHH:mm:ssZ",
    "modified_files": [],
    "forbidden_modified_files": [],
    "unauthorized_files": [],
    "patch_plan_mismatch": false,
    "product_code_modified": false,
    "assertion_expected_value_changes_detected": false,
    "tests_deleted": false,
    "skip_or_xfail_added": false,
    "unrelated_tests_modified": false,
    "high_risk_proposal_applied": false,
    "passed": true,
    "violations": []
  }

IF passed == false OR file does not exist:
  → Set phases.healing.status = failed
  → Set workflow_status = stopped
  → STOP immediately
  → Do NOT rerun
  → Report which file and which rule was violated (or that the evidence file is missing)
```

---

## Stop Conditions

Stop the workflow immediately when any of the following is true:

- Required input files are missing and cannot be generated by the current phase
- Review JSON is missing or is invalid JSON
- `decision == "reject"` in any review
- `human_review_required == true` and `force_continue == false`
- `risk_level in ["high", "critical"]` and `force_continue == false`
- **Codegen hard gate failure** (always stops — `force_continue` MUST NOT bypass):
  - `codegen_readiness == "not_ready"`
  - `blockers` non-empty in plan review JSON
  - any `needs_review` item with `blocking == true`
  - missing `.aws/data-knowledge.yaml` before codegen
  - `decision != "pass"` when entering codegen
- Fix attempt count exceeds `max_case_fix_attempts` or `max_plan_fix_attempts`
- Healing attempt count exceeds `max_healing_attempts` (`phases.healing.status == exhausted`)
- `phases.execution.status == FAIL` and healing skills are unavailable (`gates.healing_available == false`) and `fix_proposal_eligible` failures exist
- Archive attempted when `phases.execution.status == FAIL` or `phases.healing.status in [applied, exhausted, failed]`
- Archive attempted when `inspect/failure-analysis.json.source_batch_id != phases.execution.batch_id` (stale inspect)
- Codegen requires guessing unknown product behavior (route, auth, selector, factory)
- Test execution environment is unavailable (`aws` CLI or uv/pytest not installed)
- A document-driven optional subagent returns an unrecoverable error (inline orchestration does not use skill-loading subagents)
- **Codegen subagent violations (always stops — no bypass):**
  - Any AWS phase skill (`aws-api-codegen`, `aws-e2e-codegen`, or any other phase skill) is delegated to a subagent or background task
  - `aws-api-codegen` or `aws-e2e-codegen` executes in a background agent instead of inline in the primary agent
  - Phase 7A or Phase 7B codegen skill is loaded but not executed inline (skill loaded ≠ phase complete)
  - Phase 7A codegen summary (`codegen/api-codegen-summary.md`) is missing after codegen was claimed complete
  - Phase 7B codegen summary (`codegen/e2e-codegen-summary.md`) is missing after codegen was claimed complete
  - `workflow-state.yaml` does not show `phases.api_codegen.status = done` or `phases.e2e_codegen.status = done` when required
- **Phase 8 gate violations:**
  - `run_tests == true` and Phase 7 Completion Gate passed, but Phase 8 `aws-run` is not executed
  - Phase 8 executes but `execution/execution-manifest.yaml` is missing after the run
- **Healing loop violations:**
  - `phases.execution.status == FAIL` and no `fix_proposal_eligible` failures and `phases.healing.status == not_needed` (no auto-fix path; require human)
  - `gates.healing_available == false` and `phases.execution.status == FAIL` and `fix_proposal_eligible` failures exist
  - Inspect safety gate triggered: `aws-inspect` modified forbidden files during Phase 9 or Phase 13
  - Fixer safety gate triggered: fixer modified product code, weakened assertions, added skip/xfail, deleted tests, or modified unrelated tests
  - Phase 12 `aws-run` did not produce a new batch — `execution-manifest.yaml` not updated
  - `phases.healing.status == exhausted` (max attempts reached)
  - `phases.healing.status == failed` (fixer wrote error file or safety gate triggered)

When stopped, **report** the exact stop reason, which file or gate triggered it, and what a human must do to resume. In orchestrated mode, do **not** ask for chat confirmation to bypass a gate.

---

## Final Response Format

After the workflow completes or stops, always output this structure:

```
AWS workflow <completed | completed_with_warnings | failed | stopped>.

Workflow status: <completed | completed_with_warnings | failed | stopped>
Change ID: <change-id>
Current phase: <phase that completed or stopped>
Stop reason: <if stopped>

Review gates:
  case-review.json: present | missing | invalid | pass | needs_fix | needs_human_review | reject
  api-plan-review.json: present | missing | invalid | pass | needs_fix | needs_human_review | reject | not_applicable
  plan-review.json: present | missing | invalid | pass | needs_fix | needs_human_review | reject | not_applicable

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

Codegen:
  api_codegen: pending | done | failed | stopped | not_applicable
  e2e_codegen: pending | done | failed | stopped | not_applicable
  api_codegen_summary: present | missing | not_applicable
  e2e_codegen_summary: present | missing | not_applicable
  stop_reason: <if api_codegen or e2e_codegen == stopped>

Execution:
  expected: true | false   # true when run_tests == true and Phase 7 gate passed
  executed: true | false   # true only if aws-run ran inline in primary agent
  runner: primary (aws run) | fallback (direct pytest) | —
  final_status: <PASS | PASS_WITH_WARNINGS | FAIL | SKIPPED | —>
  manifest: execution/execution-manifest.yaml | missing | not_applicable
  stop_reason: <if expected == true but executed == false>

Known product issues:
  count: <N>
  status: none | present
  files:
    - qa/changes/<change-id>/known-product-issues.md       (source of truth, human/reviewer acknowledged; codegen append-only implementation notes)
    - qa/changes/<change-id>/execution/known-product-issues.md  (execution snapshot)
    - qa/changes/<change-id>/inspect/known-product-issues.md    (inspect-confirmed)

Healing:
  status: <not_needed | proposal_created | applied | resolved | exhausted | failed | skipped | —>
  attempts: <N>
  healing_available: <true | false>
  eligible_failures: <N>
  applied_files: <list or —>
  latest_inspect_batch_id: <batch_id or —>   # must match phases.execution.batch_id before archive

Execution mode: inline
Subagent usage: <none | exploration_only>
  used: <true | false>
  purpose: <source_exploration_only | document_driven_parallel | none>
  loaded_skills: <true | false>   # must be false
  affected_gates: <true | false>  # must be false

Agent Warnings:
  - OPENCODE-SKILL-RESOLUTION-001: workflow executed inline because subagent skill inheritance is unreliable.
  - AWS-HEALING-SKILLS-UNAVAILABLE: optional healing skills missing; healing loop unavailable on eligible failures.

Warnings:
  - <any warnings from healing, fallback runner, known issues, missing optional skills, etc.>

Next action:
  <what the user should do next>
```

Do not report any phase as complete unless its expected output files exist and were verified.

Do not claim the workflow succeeded if it stopped before Phase 9.

If `run_tests == true`, do **not** report the workflow as `completed` or `completed_with_warnings` unless:

- Phase 8 (`aws-run`) executed inline in the primary agent.
- `execution/execution-manifest.yaml` exists on disk.
- `final_status` was read from the manifest (not from chat or claim).

If `run_tests == true` but Phase 8 did not execute, report `Workflow status: stopped` and include `Execution.stop_reason`.

**Workflow status mapping:**

| Condition | Workflow status |
|---|---|
| All gates pass, execution `PASS`, no known issues | `completed` |
| All gates pass, execution `PASS_WITH_WARNINGS` or known issues exist | `completed_with_warnings` |
| Execution `FAIL`, healing `exhausted`, or healing `failed` | `failed` |
| Workflow stops before execution due to missing inputs, invalid gates, `human_review_required`, missing `.aws/data-knowledge.yaml`, unavailable environment, or missing required skill | `stopped` |
| `run_tests == true` but Phase 8 was not executed (codegen stopped, subagent violation, or Phase 7 gate failed) | `stopped` |
| `run_tests == true`, Phase 8 executed, but `execution/execution-manifest.yaml` is missing | `stopped` |
| Codegen delegated to subagent or background task (`forbidden_codegen_attempt`) | `stopped` |

Do not use `completed` when execution is `PASS_WITH_WARNINGS` or known product issues are present — use `completed_with_warnings`.

Do not report the workflow as `completed` or `completed_with_warnings` unless every applicable review gate (`case-review.json`, and `api-plan-review.json` / `plan-review.json` per `test_types`) is present, valid, and has `decision == "pass"`.

---

## Known Product Issue Reporting

The workflow must distinguish between:

```text
tests passed cleanly
tests passed with known product issues
tests failed
```

If any of the following exist, the final workflow `Status` must be `completed_with_warnings`, not `completed`:

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
completed_with_warnings        (workflow-level status)
PASS_WITH_WARNINGS             (execution final_status)
archived_with_warnings         (archive status)
```


