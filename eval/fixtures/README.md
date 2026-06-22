# Eval Fixture Tiers

Golden seed content and tier manifests for phase-scoped AI eval. Used by `scripts/eval-seed-change.mjs` (Task 3) to populate a bench change directory before each eval attempt.

## Tier cumulative model

Tiers form an **extends chain** — each tier inherits all `paths` from its parent and adds its own. Manifests live in `eval/fixtures/tiers/*.yaml`.

```text
L0-case-seed
  └── L1-plan-seed
        └── L2-api-codegen-seed
              └── L3-run-seed
```

| Tier | Eval suite | What gets seeded |
|------|------------|------------------|
| **L0** | `workflow-case` (case-only) | `proposal.md`, `.qa.yaml`, `.aws/data-knowledge.yaml` |
| **L1** | (plan-only baseline, not a suite) | L0 + `cases/**`, `review/case-review.json`, `facts/fact-baseline.json`, `workflow-state.yaml` |
| **L2-api** | `workflow-api-codegen` (codegen-only) | L1 + API plan files + `review/api-plan-review.json` |
| **L3** | `workflow-run` (aws run) | L2 + generated `tests/api/**` stubs |

`paths` are **relative to the sample root** (`eval/fixtures/samples/<sample-id>/`). The seed script copies each listed path from the sample into the target change directory (or bench `tests/` for L3 test paths — see Task 3 `copyTierToChangeDir`).

Optional `resets` blocks patch `workflow-state.yaml` and `.qa.yaml` after copy (e.g. L2 sets `phases.api_codegen.status: pending` so codegen eval does not inherit archive `done` state).

## Change-id token

The canonical eval change id is **`eval-sample-001`**. Golden sample files use this id in:

- `workflow-state.yaml` → `change_id`
- `.qa.yaml` → `change_id`
- `review/*.json` → `change_id`

At seed time, `eval-seed-change.mjs` may substitute `<change-id>` from the `--change` CLI arg so the same fixture tier can target `qa/changes/eval-sample-001/` or a dataset-specific id (e.g. `WC-001` mapped to the bench path).

## Direct Bench usage

Eval does **not** copy the whole bench repo. It seeds directly into:

```text
bench/fastapi-vue-admin/
  qa/changes/eval-sample-001/    ← seeded from fixture tier before each run
  tests/api/                     ← L3 tier also seeds generated test stubs here
  opencode.json                  ← skills.paths → assurance-workflow-skills/skills/
```

Typical flow (see `eval-workflow-run.mjs` / `eval-aws-run.mjs`):

1. **Seed** — apply fixture tier → `qa/changes/<change-id>/` (+ `tests/` for L3)
2. **Reset state** — apply tier `resets` (align `test_types`, phase status)
3. **Run** — OpenCode (`eval-workflow-run.mjs`) or `aws run` (`eval-aws-run.mjs`)
4. **Archive** — copy change dir (+ execution artifacts) → `eval/runs/<run-id>/.../raw-output/`

## Golden sample

| Sample | Module | Dataset | L0 tier |
|--------|--------|---------|---------|
| `eval-sample-001` | users（用户管理） | WC-001 | `L0-case-seed` |
| `eval-sample-002` | roles（角色管理） | WC-002 | `L0-case-seed-roles` |
| `eval-sample-003` | menus（菜单管理） | WC-003 | `L0-case-seed-menu` |
| `eval-sample-004` | depts（部门管理） | WC-004 | `L0-case-seed-dept` |

`eval-sample-001` is trimmed from `bench/fastapi-vue-admin/qa/changes/20260612-user-mgmt/` (user management module). Samples 002–004 provide golden seeds for role, menu, and department modules. All exclude heavy runtime artifacts (`execution/`, `healing/`, `inspect/`).

Each L0 tier sets `source_prefix` to its sample directory so tier resolution reads the correct golden files. `fake-opencode-eval.mjs` resolves the golden sample from `EVAL_CHANGE_ID` (e.g. `eval-sample-002` → `eval/fixtures/samples/eval-sample-002`).

## Adding tiers or samples

- New sample: copy under `eval/fixtures/samples/<id>/`, update `change_id` fields, point tier `source_prefix` or dataset input at it.
- New L2 variant (e2e/fuzz/perf): extend `L1-plan-seed` with the corresponding `plans/` and `review/` paths (see design spec §4.1).
