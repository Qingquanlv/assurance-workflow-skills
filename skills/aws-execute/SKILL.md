---
name: aws-execute
description: "Run two-stage AWS execute mode: autonomous post-intake phases from fact-baseline through report/archive eligibility, preserving hard gates."
---

# AWS Execute

`aws-execute` is the **two-stage / autonomous execution** entrypoint. It resumes after `aws-intake` has completed and runs the post-case workflow without planned clarification dialogue.

It owns only the execute scope:

```text
fact-baseline -> plan/review/fix -> codegen -> execution -> inspect -> healing -> report -> archive-eligibility
```

It does not run explore, case-design, case-review, or case-fix.

## What is inline here vs referenced

To reduce execution omission, the **ordered execute runbook is inline in this file** (see **Execute Runbook** below) — the phase sequence, every gate-check point, the healing CLI sequence, and execute-scope stop conditions are written here as a gap-free checklist, not as a cross-reference.

Two things are still **referenced** from `skills/aws-workflow/SKILL.md` (shared across all modes; single source of truth to avoid drift):

- **Shared orchestration mechanics**: Scheme E dispatch + state-hash rules, Phase Completion Rule, Skill Load Gate, Phase → Skill Path Map, `workflow-state.yaml` schema, Subagent Usage Disambiguation, Context Budget / Session Handoff.
- **Deep per-phase contracts**: the detailed input/output/gate contract of each phase lives in that phase's own skill (`aws-fact-baseline`, `aws-api-plan`, `aws-api-codegen`, `aws-run`, `aws-inspect`, `aws-fix-proposal`, the fixers, `aws-report`). Load the phase skill when `aws status --next` dispatches it; the runbook below only sequences them.

State machine enforcement (`aws state heal`, `aws gate override`, `aws status` audits) is inlined into the runbook's healing and human-review steps below.

## Startup

1. Resolve `<change-id>` and runtime params exactly as `aws-workflow` does.
2. Ensure `workflow-state.yaml.params.run_mode` is one of `full`, `api-only`, `e2e-only`, `plan-only`, `codegen-only`, or `review-plan`.
3. Stamp the derived run context:

```bash
aws state stamp-run-context --change <change-id> --orchestrator aws-execute
```

This writes:

```yaml
run_context:
  orchestrator_skill: aws-execute
  interaction_mode: autonomous
  active_scope: execute
```

Do not hand-write `run_context`.

## Preflight

Before dispatching any phase, verify the intake artifacts and shared test infra that form the handoff:

1. `review/case-review.json` exists and `decision == "pass"`; otherwise STOP and tell the user to run `aws-intake`.
2. `explore/advisory.json`, when present, has no `open_questions_for_case_design[].status == "unanswered"`; otherwise STOP and tell the user to finish intake.
3. `qa/changes/<change-id>/cases/` exists and contains case delta YAML; otherwise STOP and tell the user to run `aws-intake`.
4. `workflow-state.yaml` exists and contains completed intake phase state sufficient for cross-scope dependencies.
5. **Test infra scaffold** (idempotent check — **no interactive questions in execute mode**):
   - `tests/config.py`, `tests/conftest.py`, and `tests/schema_validation.py` must exist under the project root and pass the per-file contract in `aws-test-infra-bootstrap/SKILL.md`.
   - If `phases.test_infra_bootstrap.status == done` in `workflow-state.yaml`, treat as satisfied when all 3 files still pass contract.
   - If any file is missing or non-conformant → **STOP** with: `Test infra not ready. Run aws-intake (Phase 0 bootstrap) or aws-test-infra-bootstrap manually. Execute mode does not ask for config.`

This preflight replaces a separate intake handoff file. Do not create `intake-approved.yaml`.

## Orchestration Loop

Use the `aws-workflow` Scheme E / inline orchestration loop unchanged, with the current `run_context.active_scope = execute`. `aws status --change <id> --next --json` drives phase selection and only dispatches execute-scope phases; intake phases remain out of scope but still satisfy dependencies when their produces/gates are done. Planned Explore / case-design questions are not asked in this mode.

The **Execute Runbook** below is the ordered checklist the loop walks. Do not skip a step because it "looks done" — verify each phase's produces on disk and run the listed CLI at each point.

## Execute Runbook (ordered, inline)

`test_types` gates the API / E2E / Fuzz / Performance branches (`layers.*` after Phase 2.5). `run_mode` may narrow the range (e.g. `codegen-only`). Within each dispatched phase, load that phase's skill for its full contract.

**Phase Completion Rule (inline — do not skip).** Producing artifacts on disk is NOT phase completion. After every phase below you MUST also write its state back into `workflow-state.yaml`, then run `aws status`. The write mechanism differs by phase and is spelled out on each line:

- **CLI-backed phases** (`execution`, `inspect`, `healing-rerun`, `report`) — the `aws state apply --phase <x>` / `aws state heal` call IS the state write; it is mandatory and enforced.
- **Healing status** (`healing.status`) — CLI-only via `aws state heal`; never hand-write.
- **Agent phases** (`fact_baseline`, `api_plan`, `e2e_plan`, `*_plan_review`, `api_codegen`, `e2e_codegen`, `archive`) — no CLI writer; you MUST hand-update `phases.<x>.status` (+ produces/gate refs) in `workflow-state.yaml` before advancing. `aws status` re-derives these from artifacts for routing, but the file is the human-readable record — leaving them stale is the exact omission that made a prior run look "never executed".

Each runbook line ends with its state-write obligation as `⟶ state: …`.

```
Phase 2.4 — Fact Baseline  (always, after intake case-review passed)
  → dispatch aws-fact-baseline → facts/fact-baseline.json
  → autonomous: if facts unavailable, write source: unavailable + warning, DO NOT stop
  → ⟶ state: hand-update phases.fact_baseline.status = done (+ produces ref); then aws status

Phase 2.5 — Layer Scan  (orchestrator-local)
  → resolve layers.{api,e2e,fuzz,performance} from test_types + case types

[API branch — if layers.api]
Phase 3A — API Plan            → dispatch aws-api-plan → plans/api-*.md
  → ⟶ state: hand-update phases.api_plan.status = done (+ produces ref); then aws status
Phase 4A — API Plan Review     → dispatch aws-api-plan-reviewer → review/api-plan-review.json
  → aws gate check --phase api-plan-review --change <id> --json      ← REQUIRED
  → ⟶ state: hand-update phases.api_plan_review.status + gate verdict ref
Phase 5A — API Plan Fix loop   → if gate needs_fix: aws-api-plan-fixer → aws-api-plan-reviewer → aws gate check
  → repeat up to max_plan_fix_attempts; reject / human_review_required → see Human Review below
Phase 6A — API Codegen pre-check → verify repo:.aws/data-knowledge.yaml exists, else STOP (hard gate; force_continue MUST NOT bypass)
Phase 6A — API Codegen         → dispatch aws-api-codegen (INLINE, never a nested subagent) → codegen/api-codegen-summary.md + target files
  → ⟶ state: hand-update phases.api_codegen.status = done (+ produces ref); then aws status

[E2E branch — if layers.e2e]
Phase 3B — E2E Plan            → dispatch aws-e2e-plan → plans/e2e-*.md
  → ⟶ state: hand-update phases.e2e_plan.status = done (+ produces ref); then aws status
Phase 4B — E2E Plan Review     → dispatch aws-e2e-plan-reviewer → review/plan-review.json
  → aws gate check --phase e2e-plan-review --change <id> --json      ← REQUIRED
  → ⟶ state: hand-update phases.e2e_plan_review.status + gate verdict ref
Phase 5B — E2E Plan Fix loop   → if needs_fix: aws-e2e-plan-fixer → aws-e2e-plan-reviewer → aws gate check
Phase 6B — E2E Codegen pre-check → verify repo:.aws/data-knowledge.yaml exists, else STOP (hard gate)
Phase 6B — E2E Codegen         → dispatch aws-e2e-codegen (INLINE) → codegen/e2e-codegen-summary.md + target files
  → framework pytest-playwright; never emit *.spec.ts
  → ⟶ state: hand-update phases.e2e_codegen.status = done (+ produces ref); then aws status

[Fuzz / Performance branches — if layers.fuzz / layers.performance: same Plan → Review(gate check) → Codegen shape]

Phase 6 Completion Gate
  → for each selected layer: phases.<layer>_codegen.status == done AND summary + all Target Files on disk, else STOP
  → if run_tests == false: phases.execution.status = SKIPPED → jump to Phase 14

Phase 7 — Execution  (MANDATORY when run_tests == true and Phase 6 gate passed; skipping is a STOP)
  → bash: aws run --change <id>
  → after this formal batch, any test-file modification is healing scope; `aws run`
    records tests_tree_sha256 and refuses changed tests unless healing.status == applied
  → TEST-CHANGE DISCIPLINE (hard rule, not bypassable by the agent):
      - once a formal batch exists, the ONLY path for modifying test files is the healing
        loop: aws report inspect → aws-fix-proposal → fixer → aws state heal --to applied → aws run
      - the agent MUST NEVER construct a command containing --allow-test-changes.
        On TESTS-CHANGED-WITHOUT-HEALING or ALLOW-TEST-CHANGES-FORBIDDEN the correct
        reaction is to enter/continue the healing loop, or STOP and surface to the user —
        never to retry with an override flag
      - --allow-test-changes is reserved for a human typing it themselves after this
        project's execution-policy.json is temporarily relaxed from "forbidden";
        one authorization covers exactly one batch
      - healing attempts exhausted (healing.status == exhausted) → STOP; the decision
        (raise max_healing_attempts / manual fix / accept + document known issue) belongs to the user
  → verify execution/execution-manifest.yaml on disk; read final_status from it (never from claim)
  → ⟶ state (CLI-backed, mandatory): aws state apply --change <id> --phase execution
  → aws status

Phase 8 — Inspect  (if execution FAIL / PASS_WITH_WARNINGS, or known-product-issues present)
  → dispatch aws-inspect → inspect/failure-analysis.json + failure-summary.md
  → ⟶ state (CLI-backed, mandatory): aws state apply --change <id> --phase inspect
  → Inspect Safety Gate: if inspect modified any forbidden file → STOP
  → Healing entry decision (MANDATORY — healing.status must leave `pending` here; it is
    the "should heal but not started" marker and must NEVER be a resting/terminal state):
      PASS / PASS_WITH_WARNINGS and no fix_proposal_eligible → aws state heal --to not_needed → Phase 14
      FAIL and no fix_proposal_eligible                       → aws state heal --to not_needed → STOP (needs human)
      gates.healing_available == false                        → aws state heal --to skipped ; FAIL → STOP
      inspect_mode != primary                                 → STOP (healing needs primary inspect)
      FAIL and fix_proposal_eligible exist                    → enter Healing loop (do NOT jump to Report)
  → Do not proceed to Report until healing.status ∈ {not_needed, skipped, resolved, exhausted, failed}.
    `aws status` audits this: inspect done + report/terminal reached while healing.status is
    pending/applied/proposal_created ⇒ HEAL-STATE-INCONSISTENT ⇒ terminal `stopped`.

[Healing loop — Phases 9–12; healing.status is CLI-only via aws state heal]
Phase 9  — Fix Proposal   → dispatch aws-fix-proposal → healing/fix-proposal.json (+ .md)
  → if summary.eligible_count == 0: aws state heal --to not_needed ; FAIL → STOP
  → aws state heal --change <id> --to proposal_created        ← allocates attempts[n]
Phase 10 — Apply Fixes    → dispatch aws-api-codegen-fixer and/or aws-e2e-codegen-fixer (INLINE)
  → verify healing/*-apply-summary.json ; if *-fixer-error.json written → STOP
  → Fixer Safety Gate (healing/fixer-safety-check.json): produced by `aws state heal --to applied` (CLI computed; agent hand-written safety files are overwritten). If product code / unauthorized assertions / deletions touched → STOP or human-review gate.
  → all fixers no_op → STOP (proposal/authorization mismatch); any failed → aws state heal --to failed ; STOP
  → aws state heal --change <id> --to applied                 ← required before rerun
Phase 11 — Re-run         → bash: aws run --change <id>       ← changed tests are allowed only because healing.status == applied
  → If `--allow-test-changes` was used outside healing, verify `execution/runs/<batch-id>/test-changes-override.json` exists and is referenced from events/report.
  → verify a new batch id ; aws state apply --change <id> --phase healing-rerun
Phase 12 — Re-inspect     → dispatch aws-inspect
  → verify failure-analysis.json.source_batch_id == latest execution batch, else STOP (stale)
  → Inspect Safety Gate again
  → PASS / PASS_WITH_WARNINGS → aws state heal --to resolved → Phase 14
  → FAIL and attempts < max and eligible remain → loop back to Phase 9
  → attempts exhausted → aws state heal --to exhausted → STOP (needs human)

Phase 13 — Report  (terminal, non-gating)
  → PRECONDITION: healing.status ∈ {not_needed, skipped, resolved, exhausted, failed}.
    If still pending/applied/proposal_created → the healing decision was skipped: go back to
    the Healing entry decision (Phase 8) or the loop; do NOT run Report yet.
  → dispatch aws-report → report/quality-report.{json,md} + executive-summary.md
  → ⟶ state (CLI-backed, mandatory): aws state apply --change <id> --phase report

Phase 14 — Archive Eligibility Recommendation
  → evaluate ONLY (never load aws-archive, never write qa/archive/):
      execution.status in [PASS, PASS_WITH_WARNINGS]; healing.status in [not_needed, resolved, skipped]
      (applied alone is NOT eligible); failure-analysis source_batch_id == execution batch; no unresolved eligible failures;
      inspect-safety-check passed; if resolved: fixer-safety-check passed; all review JSON decision == pass
  → HEAL-BYPASS audit: scan events.jsonl for human_override(action=allow_test_changes) events
      that occurred AFTER the first formal execution batch. If any exist AND
      healing.status == not_needed → this change bypassed the healing loop:
        archive.status = not_eligible (blocker: heal-bypass)
        archive requires the user to explicitly acknowledge each override before proceeding
      (overrides before the first formal batch — e.g. infra backfill — do not trigger this)
  → if quality-report Human Overrides count > 0: executive-summary MUST include a
      process-deviation note; a bare score with no deviation note is incomplete
  → ⟶ state: hand-update phases.archive.status = eligible | not_eligible (+ blockers) ; report recommendation
```

### Human Review (execute scope) — no hand-written pass

When a plan-review gate returns `needs_human_review` (or `reject`, or `risk_level in [high, critical]`): **STOP** and surface findings. Never edit `review/*.json` to `decision: pass`. Legitimate recovery:

```
aws gate override --change <id> --phase <review-phase> --action fix_and_proceed --reason "<user decision>"
  → then aws-<x>-plan-fixer runs in human_approved mode (verifies human_override.review_sha256 matches)
  → aws-<x>-plan-reviewer re-review → new review JSON → aws gate check
```

Codegen hard gates (`not_ready`, blockers, missing `data-knowledge.yaml`) are **not** overridable. `aws status` audits every loop for `tampered` review JSON, illegal verdict migrations, and healing-state inconsistency; any of these sets terminal `stopped`.

## Completion Condition

`aws-execute` is complete when `aws status --change <id> --next --json` reports terminal `completed` for `active_scope: execute`.

Final message should summarize:

- execution status and report paths;
- any hard gate that stopped the run;
- archive eligibility if Phase 14 ran.
