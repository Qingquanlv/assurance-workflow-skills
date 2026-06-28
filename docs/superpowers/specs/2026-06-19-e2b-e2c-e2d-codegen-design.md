# E2b / E2c / E2d Codegen Eval Suites — Design Spec

**Date:** 2026-06-19  
**Status:** Approved (方案 B + P0/P1 corrections)  
**Scope:** `workflow-e2e-codegen`, `workflow-fuzz-codegen`, `workflow-performance-codegen`

---

## 1. Goals

Add three eval suites mirroring E2a (`workflow-api-codegen`) with suite-specific scorers, narrow write allowlists, self-contained fixtures, and CI smoke (fake OpenCode). v1 ships **one smoke sample each** (`WEEC-001`, `WFUZ-001`, `WPER-001`).

---

## 2. Architecture (方案 B)

- **Three scorer modules:** `workflow_e2e_codegen.ts`, `workflow_fuzz_codegen.ts`, `workflow_performance_codegen.ts`
- **Shared helpers:** `_shared/codegen_scorer_helpers.ts`, `_shared/locust_collect.ts`, extensions to `workflow_metrics.ts`
- **Executor:** reuse `eval-workflow-run.mjs` (`run_mode=codegen-only`) with `--test-types` routing to `aws-{e2e,fuzz,performance}-codegen`
- **Evidence root:** canonical `attemptDir` only — scorers receive `attemptDir` from runner; `resolveRawOutputDir(attemptDir)` → `attemptDir/raw-output`. **No latest-pointer or historical run fallback.**

---

## 3. P0 Corrections

### P0-1 Write allowlists (narrow, no `tests/**` union)

| Policy key | Allowed write paths |
|------------|---------------------|
| `workflow_api_codegen` | `qa/changes/**`, `tests/api/**`, `eval/runs/**` |
| `workflow_e2e_codegen` | `qa/changes/**`, `tests/e2e/**`, `eval/runs/**` |
| `workflow_fuzz_codegen` | `qa/changes/**`, `tests/fuzz/**`, `eval/runs/**` |
| `workflow_performance_codegen` | `qa/changes/**`, `tests/perf/**`, `eval/runs/**` |

### P0-2 Review file paths (suite-specific)

| Suite | Review JSON |
|-------|-------------|
| E2b e2e | `review/e2e-plan-review.json` |
| E2c fuzz | `review/fuzz-plan-review.json` |
| E2d perf | `review/performance-plan-review.json` |

Skills and fixtures updated; **not** generic `review/plan-review.json`.

### P0-3 Secret scan scope (all codegen suites)

Scan **all** of:

1. Generated files under project (suite-specific glob)
2. `attemptDir/stdout.log`, `attemptDir/stderr.log`
3. `attemptDir/raw-output/**` (plans, review, codegen summaries)
4. `attemptDir/evidence/**` (write-scan artifacts)
5. Explicit codegen summary paths under raw-output

Implemented via `buildCodegenSecretScanOpts()` in `codegen_scorer_helpers.ts`.

### P0-4 Canonical evidence root

- Runner passes `attemptDir` to scorer once per attempt.
- Scorers read only `attemptDir`, `attemptDir/raw-output`, `attemptDir/evidence`.
- Forbidden-write reads `evidence/write-diff.json` from **that** attempt only.

### P0-5 Single test type per suite run

`resolveWritePolicy(runMode, testTypes)` requires **exactly one** test type when `run_mode=codegen-only`. Multiple types → throw (fail-closed). No allowlist union.

| Dataset | Allowed `test_types` |
|---------|----------------------|
| WEEC-* | `[e2e]` |
| WFUZ-* | `[fuzz]` |
| WPER-* | `[performance]` |

---

## 4. Metrics

### E2b — `workflow-e2e-codegen`

| Metric | Gate |
|--------|------|
| `schema_valid_rate` | hard |
| `collection_success_rate` | hard |
| `test_executable_rate` | hard (Definition A, `tests/e2e`) |
| `secret_leak_count` | hard |
| `forbidden_write_executed_count` | hard |
| `evidence_integrity` | hard |
| `codegen_summary_present_rate` | observe |
| `framework_compliance_rate` | observe (no `tests/e2e/**/*.spec.ts`) |
| `plan_gate_satisfied_rate` | observe (`e2e-plan-review.json`) |
| `target_file_coverage_rate` | advisory ≥0.95 |

### E2c — `workflow-fuzz-codegen`

Same hard core; paths `tests/fuzz/**`.  
`schema_valid_rate` includes `import schemathesis` check.  
Observe: `fuzz_plan_gate_pass_rate`, `openapi_ref_valid_rate` (static only, v1 observe).

### E2d — `workflow-performance-codegen`

Hard core on `tests/perf/**`.  
`collection_success_rate` / `test_executable_rate` via `locust --list` (pinned `locust==2.32.4` in CI) with **AST fallback** (`HttpUser` + `@task`).  
Observe: `performance_plan_gate_pass_rate`, `threshold_declared_rate`.

---

## 5. Fixtures (P1-1 self-contained)

Golden sample: **`eval-sample-002`** (roles). All plans, reviews, codegen summaries, and minimal generated stubs live under `eval/fixtures/samples/eval-sample-002/` — **no runtime dependency on bench `qa/changes/` history.**

L2 tiers:

- `L2-e2e-codegen-seed-roles`
- `L2-fuzz-codegen-seed-roles`
- `L2-performance-codegen-seed-roles`

Each extends `L1-plan-seed-roles`, seeds plan + review paths, resets `phases.*_codegen.status: pending` and `test_types`.

---

## 6. CI

`eval-smoke.yml` fake OpenCode job adds:

```bash
pip install pytest httpx schemathesis locust==2.32.4
# WEEC-001, WFUZ-001, WPER-001 + gate
```

Playwright **not** required for v1 smoke (minimal collect-only e2e stubs).

---

## 7. Deferred

- `openapi_ref_valid_rate` hard gate (live backend) → E4 / workflow-full

## Dataset coverage (v1.1)

| Suite | Samples |
|-------|---------|
| E2b | WEEC-001 (smoke) … WEEC-004 (roles/menu/dept) |
| E2c | WFUZ-001 … WFUZ-004 |
| E2d | WPER-001 … WPER-004 |

| E4 | WF-001 … WF-004 (users/roles/menus/depts) |
