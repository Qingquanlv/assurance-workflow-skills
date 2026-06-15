---
name: aws-report-generator
description: "AWS M1: Generate a deterministic, human-readable quality report for a change via `aws report generate --change <change-id>`. Use after aws-inspect has produced quality-gate-result.json. Calls the CLI to compute the Quality Score and write quality-report.json, quality-report.md, and executive-summary.md. Never fabricates the score, final status, or a release recommendation."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify inspect is complete: `phases.inspect.status == done`. If not, stop and instruct the user to run `aws report inspect --change <change-id>` first.
3. Verify the CLI wrote `qa/changes/<change-id>/inspect/quality-gate-result.json`. If missing, stop — do not fabricate a report.
4. Verify **Assurance Workflow Skills CLI identity** (see **AWS CLI Identity Check**) before invoking `aws report generate`.
5. Use files as the sole source of truth.

**After completing work:**

1. Verify the CLI wrote (do not synthesize):
   - `qa/changes/<change-id>/report/quality-report.json`
   - `qa/changes/<change-id>/report/quality-report.md`
   - `qa/changes/<change-id>/report/executive-summary.md`
2. Update `workflow-state.yaml`:
   - `phases.report.status = done`
   - `phases.report.quality_score = <int from quality-report.json>`
3. Reference `report/executive-summary.md` in the workflow's final summary.

---

# Skill: aws-report-generator

## Purpose

Produce a deterministic, research-and-dev-readable quality report for a change: a 0-100 Quality Score, dimension breakdown (Functional, Coverage, Fuzz, Performance), defect buckets, and a risk/recommendation conclusion. When fuzz and/or performance ran, the report adds a **Fuzz** functional line and a **Non-Functional (Performance)** chapter with per-scenario p95 / error-rate verdicts.

## Skill vs CLI Boundary

The CLI (`aws report generate`) is the **only trusted layer** that computes `quality_score` and assembles the structured report. This skill:

- Invokes the CLI.
- Verifies the output files exist.
- May refine the **wording** of `risk_rationale` / `recommendation` based on the CLI's `quality-report.json`.
- **Must not** recompute or change `quality_score` or `final_status`.

## AWS CLI Identity Check

This skill calls the **Assurance Workflow Skills CLI** (`aws`) — **not** the Amazon Web Services CLI.

Before running `aws report generate --change <change-id>`, run `aws --version` and confirm it identifies the Assurance Workflow Skills CLI. If it does not, do **not** run the command; report the problem and stop.

## CLI Invocation

```bash
aws report generate --change <change-id>
```

## Inputs (read by the CLI)

```
execution/api-result.json
execution/e2e-result.json
execution/coverage-result.json
inspect/failure-analysis.json
inspect/quality-gate-result.json     ← required (gate conclusion + final_status, incl. fuzz/non_functional when run)
qa/changes/<change-id>/cases/**/case*.yaml   ← best-effort scope (cases + requirements)
```

## Quality Score (deterministic, CLI-computed)

The CLI computes the score by renormalising the **active** dimensions to 100. A dimension is inactive (and shown as `N/A`) when it did not run: coverage unavailable, no fuzz target, or no performance scenario.

The weighting set is chosen automatically:

- **M1 weights** (no fuzz/performance in scope): Functional 70, Coverage 30.
- **M3 weights** (fuzz **or** performance ran): Functional 50, Coverage 20, Fuzz 15, Performance 15.

The Functional dimension is scored from API + E2E only; **fuzz is its own scoring dimension** (even though it folds into the gate's functional verdict). Inactive dimensions are dropped and the remaining weights renormalised so active dimensions can still reach 100.

```
dim points    = (dimWeight / activeWeight) × 100 × ratio
  functional ratio   = (api+e2e passed) / (api+e2e total)
  coverage ratio     = min(line_coverage / threshold.line, 1.0)
  fuzz ratio         = fuzz passed / fuzz total
  performance ratio  = scenarios passed / scenarios run (SKIPPED scenarios excluded)
quality_score = round(sum of active dimension points)
```

> The skill never recomputes — it reports the CLI's number and may only refine wording.

## Output Files (read after CLI completes)

```
qa/changes/<change-id>/report/
├── quality-report.json     ← structured (CLI-written, deterministic)
├── quality-report.md       ← full report (CLI-written)
└── executive-summary.md    ← one-page conclusion (CLI-written)
```

## Risk Level & Recommendation Boundary

The CLI emits a deterministic baseline `risk_level`, `risk_rationale`, and `recommendation`. The skill may refine the rationale wording for clarity but **must obey** these hard rules:

- **Never** output "可以上线 / safe to release" when `final_status == FAIL`.
- **Never** output "可以上线 / safe to release" when an unresolved product defect exists — the strongest allowed statement is "建议上线但需关注 / release only with caution".
- **Never** change `final_status` or `quality_score`.

## Hard Rules

- The report is a **terminal artifact**; it does **not** make gate decisions (the gate is `inspect/quality-gate-result.json`).
- `quality_score` and `final_status` come from the CLI — the skill does not recompute or alter them.
- Do **not** run report generation before `inspect` has produced `quality-gate-result.json`.
- Do **not** fabricate report files; if the CLI fails to write them, set `phases.report.status = failed` and report the failure.
- Do **not** invoke MCP as a substitute for the CLI.
