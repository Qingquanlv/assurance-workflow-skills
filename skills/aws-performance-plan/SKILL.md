---
name: aws-performance-plan
description: "AWS M3 Performance Stage 1: generate reviewable performance test plans from Performance cases before any code generation. Use when a Case Delta contains type:Performance cases. Reads case.yaml, selects type==Performance cases, and writes performance-plan.md, performance-codegen-plan.md, performance-review-summary.md. Uses Locust with absolute thresholds (no historical baseline). Never generates code, never runs Locust."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.case_review.status == pass`.
3. Read input files from disk:
   - `qa/changes/<change-id>/cases/**/case.yaml`
   - `qa/changes/<change-id>/proposal.md`
   - `.aws/config.yaml`
4. From `added` and `modified` only, select cases with `type == Performance` and `automation.required == true`. Skip `removed`. If none, stop and report.
5. Use files as the sole source of truth.

**After completing work:**

1. Write output files:
   - `qa/changes/<change-id>/plans/performance-plan.md`
   - `qa/changes/<change-id>/plans/performance-codegen-plan.md`
   - `qa/changes/<change-id>/plans/performance-review-summary.md`
2. Update `workflow-state.yaml`:
   - Set `phases.performance_plan.status = done`
   - List selected Performance case_ids under `phases.performance_plan.selected_cases`

---

# AWS Performance Plan

## Purpose

Turn `type: Performance` cases into a reviewable load-test plan. Performance testing here is **absolute-threshold**, not regression-against-baseline: each scenario declares fixed thresholds (e.g. `p95_ms`, `error_rate_max`) that the user confirmed at case design. There is no historical baseline comparison.

This skill does **not** generate code and does **not** run Locust. It is Stage 1; `aws-performance-codegen` runs only after `aws-performance-plan-reviewer` clears the gate.

## Selection Rule

- Only process cases under `added` / `modified` with `type == Performance` and `automation.required == true`.
- Every selected case MUST have `automation.performance.scenario.thresholds` with non-empty `p95_ms` and `error_rate_max`. A case without confirmed thresholds is a **blocker** — record it; the reviewer will hard-block.

## Inputs

```text
qa/changes/<change-id>/cases/**/case.yaml      (type == Performance)
qa/changes/<change-id>/proposal.md
.aws/config.yaml                               (performance settings: base_url, defaults)
```

## Outputs

### `plans/performance-plan.md`

For each Performance scenario, document:

- **Capability / endpoint** — from `automation.performance.scenario`
- **Thresholds** — `p95_ms`, `error_rate_max` (absolute, user-confirmed; never invent defaults)
- **Load profile** — `users`, `spawn_rate`, `run_time_s`
- **Target environment** — base URL source (from `.aws/config.yaml`); how auth is supplied
- **Out of scope** — this is not a baseline/regression comparison; it is a pass/fail against absolute thresholds

### `plans/performance-codegen-plan.md`

- **Target Files** — `tests/perf/locustfile_<module>.py` per module (this exact location so the runner can discover it)
- **Auth strategy** — how the Locust user authenticates (reuse known fixtures/data-knowledge; never hardcode real tokens)
- **Task mapping** — which endpoints map to which Locust tasks and weights
- **Generated File Policy** — append vs overwrite

### `plans/performance-review-summary.md`

- **Plan Readiness** — `ready | not_ready`
- **Codegen Readiness** — `ready | ready_with_warnings | not_ready`
- **Blockers** — e.g. missing thresholds, unknown base URL, auth unknown
- **Needs Review** — open questions

## Hard Rules

- Performance is **additive**: it never replaces functional API/E2E coverage.
- Thresholds are **mandatory and absolute**. No baseline comparison, no invented defaults — thresholds come from the case (`automation.performance.scenario.thresholds`).
- Never write scenario/threshold details back into `case.yaml`.
- Never generate code or run Locust in this skill.
- Hand off to `aws-performance-plan-reviewer`; do not invoke `aws-performance-codegen` directly.
