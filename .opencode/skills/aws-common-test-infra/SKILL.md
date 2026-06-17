---
name: aws-common-test-infra
description: Use after all active plan reviews pass and before PG-CODEGEN. Generates shared test infrastructure used across API, E2E, fuzz, and performance layers. Triggers on: "common test infra", "shared conftest", "preflight codegen", "common-test-infra". Runs serially before parallel codegen. Never writes layer-specific test code.
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify active plan reviews have passed for selected targets:
   - API: `phases.api_plan_review.status == pass` when `'api' in params.test_types`
   - E2E: `phases.e2e_plan_review.status == pass` when `'e2e' in params.test_types`
   - Fuzz: `phases.fuzz_plan_review.status == pass` when `state.layers.fuzz == true`
   - Performance: `phases.performance_plan_review.status == pass` when `state.layers.performance == true`
3. Read **Required** input files from disk:
   - Active codegen plans: `plans/*-codegen-plan.md` for each selected layer
   - `.aws/data-knowledge.yaml` (if missing, STOP — codegen preflight requires data knowledge)
   - `workflow-state.yaml` layer scan (`state.layers` block)
4. Read **Optional** input files (missing = warning, do not STOP):
   - Existing `tests/conftest.py`, `tests/factories/common.py`, `tests/fixtures/**`
5. Use files as the sole source of truth.

**After completing work:**

1. Write output files:
   - `tests/conftest.py` — shared pytest configuration and session fixtures
   - `tests/factories/common.py` — cross-layer factory helpers
   - `tests/fixtures/**` — shared fixture modules referenced by active codegen plans
   - `qa/changes/<change-id>/codegen/common-test-infra-summary.md`
2. Update `workflow-state.yaml`:
   - Set `phases.common_test_infra.status = done`
   - List all generated shared infra files under `phases.common_test_infra.outputs`
   - Record `phases.common_test_infra.preflight_completed = true`

## Output Contract

**Required outputs:**

| Path | Description |
|---|---|
| `tests/conftest.py` | Root pytest conftest with shared fixtures and markers |
| `tests/factories/common.py` | Shared factory utilities for all active test layers |
| `qa/changes/<change-id>/codegen/common-test-infra-summary.md` | Summary of shared infra generated and layer coverage |

**Optional outputs (when plans require them):**

| Path | Description |
|---|---|
| `tests/fixtures/**` | Shared fixture modules authorized by active codegen plans |

**Must NOT write:**

- Layer-specific test code (`tests/api/**`, `tests/e2e/**`, `tests/fuzz/**`, `qa/perf/**`)
- Layer codegen summaries (`codegen/api-codegen-summary.md`, etc.)
- Review JSON or plan files

**Write reservation:** This phase owns shared paths exclusively. PG-CODEGEN phases must not write `tests/conftest.py`, `tests/factories/common.py`, or broad `tests/fixtures/**` — only layer-specific dirs.

---

# Common Test Infrastructure (Preflight)

名称：共享测试基础设施预检

描述："在 PG-CODEGEN 并行批次之前串行执行。根据已通过 Review 的 codegen plan 和 data-knowledge 生成跨层共享的 conftest、factory 和 fixture 基础设施。不生成任何层特定的测试代码。"

## When to Use

当 Conductor 调度 `common-test-infra` 阶段时：

- 所有激活层的 plan review 已通过
- PG-CODEGEN 批次即将启动
- 需要统一的 `tests/conftest.py` 和共享 factory/fixture 基线

## Do Not Use When

- Plan review 尚未通过
- 用户直接要求生成 API/E2E 测试代码（应走层特定的 codegen 阶段）
- `.aws/data-knowledge.yaml` 不存在

## Inputs

**Required:**

- `qa/changes/<change-id>/workflow-state.yaml`
- Active `plans/*-codegen-plan.md` files
- `.aws/data-knowledge.yaml`

**Optional:**

- Existing shared test infra under `tests/conftest.py`, `tests/factories/`, `tests/fixtures/`

## Outputs

- `tests/conftest.py`
- `tests/factories/common.py`
- `tests/fixtures/**` (when authorized by plans)
- `qa/changes/<change-id>/codegen/common-test-infra-summary.md`

## Rules

1. **Serial preflight** — must complete before any PG-CODEGEN phase starts.
2. **Exclusive reservation** — shared paths are out of scope for parallel codegen reservations.
3. **Plan-driven** — only create fixtures/helpers explicitly referenced in active codegen plans.
4. **No layer code** — do not write test modules under layer-specific directories.
5. **Idempotent merge** — preserve existing shared infra when plans do not require changes; document merges in summary.
