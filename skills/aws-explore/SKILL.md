---
name: aws-explore
description: "Phase 1.1 Explore: run `aws risk context`, then write advisory.json only. Use before aws-case-design. Artifacts still live under explore/ (context.json, advisory.json). Never modify context.json or write case.yaml."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml` if it exists → `phases.explore`.
2. Derive `<project-root>` (directory containing `.aws/config.yaml`; default = cwd).
3. Read requirement text (user message, file path, or PRD text provided in context).
4. Optional: read `.aws/data-knowledge.yaml`.

**Pre-flight checks — STOP before running CLI if any condition is true:**

| Condition | Action |
|-----------|--------|
| `phases.case_design.status == done` | **STOP** — explore must run before case design. Tell the user: "当前 change 的 case 已设计完成，Explore（风险研判）应在下一个 change 开始时使用，不应事后补跑。" |
| `phases.explore.status == done` | **STOP** — explore already complete. Tell the user the advisory path and suggest reading it. |

**After completing work:**

1. Write `qa/changes/<change-id>/explore/advisory.json`
2. Do **not** write `qa/changes/<change-id>/explore/advisory.md`
3. Run `aws risk validate-advisory --change <change-id> --project-dir <project-root>`
4. On validation failure → set `phases.explore.status = failed`, record `validation_errors`
5. On success → set `phases.explore.status = done`, update counts and outputs in `workflow-state.yaml`

---

# Skill: aws-explore

## Purpose

Produce the **Explore** artifacts (Phase 0.5) from deterministic historical facts + requirement text, before `aws-case-design` begins. The Skill owns the full Explore pipeline internally.

**Does not** write `case.yaml`, modify `context.json`, or simulate `aws-case-design`.

---

## Step 1 — Run `aws risk context`

```bash
aws risk context \
  --change <change-id> \
  --project-dir <project-root> \
  [--diff-base main] \
  [--archive-depth 10] \
  [--requirement <path-if-file>] \
  [--staleness-days 30]
```

- CLI **exit != 0** → set `phases.explore.status = failed`; output one-line error; stop.
- CLI success → read `qa/changes/<change-id>/explore/context.json`.

---

## Step 2 — Weak-data gate

Check `context.degraded` and `phases.explore.weak_data_treat_as` (default: `done`):

**Hard rule:** if ALL THREE of `no_diff`, `no_cases`, `no_history` are present in `degraded_reasons`, treat as `unavailable` regardless of config — there is no evidence to reason from and the advisory would be fabricated.

| `degraded` | `weak_data_treat_as` | `degraded_reasons` | Action |
|------------|----------------------|--------------------|--------|
| false | any | — | Continue to Step 3 |
| true | `done` | partial (not all 3) | Continue to Step 3; cap confidence at `medium` |
| true | `unavailable` | any | Skip Step 3 → `status = unavailable` → END |
| true | any | all 3 present | Skip Step 3 → `status = unavailable` → END |

When `status = unavailable`: update `workflow-state.yaml`, output one-line notice, stop.

---

## Step 3 — LLM synthesis

Read `context.json` and requirement text. Produce `advisory.json` only.

### LLM Hard Rules

1. All numbers, `case_id`, `issue_id`, module names **must** come from `context.json` fields (`evidence[]`, `impact.*`, `historical_issues[]`, `case_signals[]`).
2. Every hotspot / watchlist item **must** reference ≥1 `context.evidence[].id` via `evidence_ids[]`.
3. No `evidence_ids` → item MUST be `confidence: low`. Do not generate hotspot/watchlist items with no evidence.
4. `case_design_guidance` is an **evidence-anchored channel** — never write case files. When `evidence[]`, `impact.affected_case_ids[]`, `historical_issues[]`, and `case_signals[]` are all empty, set `priority_hints`, `suggested_scenarios`, and `regression_focus` to `[]`. Do **not** fill them with generic advice or module walkthroughs — generic "at least cover" guidance belongs exclusively in `minimum_required_coverage`; degraded disclaimers belong exclusively in `executive_summary`.
5. Respect `parse_confidence_cap` on evidence — do not exceed cap in item confidence.
6. Use `evidence[]` IDs only — do not use unstable path expressions like `context.test_health[menus].pass_rate`.
7. If `context.staleness.stale == true` → cap all confidence at `medium`; add staleness disclaimer to Executive Summary.
8. `evidence_inventory` and `minimum_required_coverage` are top-level metadata fields. Do **not** place them under `hotspots` or `watchlist`.
9. In degraded / weak-data conditions, keep `hotspots` and `watchlist` empty unless there is direct `evidence_ids[]` support; never turn `minimum_required_coverage` into an evidence-backed hotspot.
10. **Channel separation (hard):** each piece of output content has exactly one home.
    - "Why the advisory is limited" → `executive_summary` only.
    - "What evidence was / wasn't available" → `evidence_inventory` only.
    - "What to cover at minimum" → `minimum_required_coverage` only.
    - "Prioritised risk signals from evidence" → `hotspots` / `watchlist` / `case_design_guidance` (when evidence exists).
    - "Open questions for case-design" → `open_questions_for_case_design` only.
    Duplicating the same content across channels is a violation.

### advisory.json schema (MVP)

Required top-level fields: `schema_version`, `change_id`, `context_ref`, `generated_at`, `executive_summary`, `hotspots`, `watchlist`, `evidence_inventory`, `case_design_guidance`, `minimum_required_coverage`, `open_questions_for_case_design`.

See `schemas/explore-advisory.schema.json` for the MVP advisory shape.

### Required degraded-output metadata

When advisory is degraded and evidence-backed signals are unavailable, `hotspots` and `watchlist` remain empty arrays, `case_design_guidance` sub-arrays are all `[]`, and the advisory MUST still populate `evidence_inventory` and `minimum_required_coverage` per the rules below.

#### evidence_inventory — derivation rules

Three buckets; populate dynamically for every change, do **not** copy-paste the example verbatim.

| Bucket | Definition | Rule |
|--------|-----------|------|
| `available` | Data that **was read and used** by this advisory | Always: `requirement_text`, `explore_context`. Add others only if actually consumed. |
| `missing` | Data the aggregator **tried to collect** (within its scope) but found empty or unavailable | = fields that are empty in `context.json` and whose absence is a degraded_reason (`no_diff` → `git_diff`/`changed_files`; `no_history` → `historical_issues`/`previous_failure_analysis`/`known_product_issues`). |
| `not_inspected` | Data that **exists and could be read** but is **outside this phase's scope** (source code, live API schema, existing test files) | Always: `existing_tests` (source files), `api_routes`, `api_schema`, `rbac_<module>_model`. Name the model after the actual module (e.g. `rbac_dept_model`, `rbac_role_model`). |

> **Caution — `existing_tests` ambiguity:** test *source files* are `not_inspected`; test *health signals* (`test_health[]` aggregated from archive) may be `missing` if the archive returned no data. These are different things — do not conflate them.

*Example (menu-management, no diff, no history):*
```json
"evidence_inventory": {
  "available": ["requirement_text", "explore_context"],
  "missing": ["git_diff", "changed_files", "historical_issues",
              "previous_failure_analysis", "known_product_issues"],
  "not_inspected": ["existing_tests", "api_routes", "api_schema",
                    "rbac_menu_model"]
}
```

#### minimum_required_coverage — derivation rules

Generate from the **module's domain shape** (CRUD operations + tree/hierarchy if applicable + RBAC/auth + negative/integrity), not from a fixed literal list. The four sub-arrays are:

| Sub-array | What to include |
|-----------|----------------|
| `api` | One entry per main API operation the module exposes (CRUD + any module-specific queries). Name in snake_case (`verb_noun`). |
| `e2e_if_enabled` | Only if E2E is in scope; cover admin happy-path flows + role-based visibility. Omit or set `[]` if E2E is excluded. |
| `negative` | Missing required fields, invalid foreign-key refs, boundary violations, unauthorized access. |
| `data_integrity` | Consistency invariants specific to this module (tree consistency, sort order, join-table consistency). |

*Example (menu-management):*
```json
"minimum_required_coverage": {
  "api": ["create_menu", "list_menu_tree", "get_menu_detail",
          "update_menu", "delete_menu", "unauthorized_access"],
  "e2e_if_enabled": ["admin_can_enter_menu_management",
                     "admin_creates_menu_and_sees_navigation",
                     "role_based_menu_visibility",
                     "non_admin_cannot_access_menu_management"],
  "negative": ["missing_required_fields", "invalid_parent_id",
               "delete_parent_menu_with_children",
               "unauthorized_menu_management_api_access"],
  "data_integrity": ["parent_child_tree_consistency",
                     "sort_order_consistency",
                     "role_menu_relation_consistency"]
}
```

### Confidence rules (§5.7)

| level | conditions |
|-------|------------|
| **high** | ≥1 evidence with `below_fail_threshold=true` (test_health) OR historical_issue source 1–2; diff module confidence ≥ medium; `staleness.stale == false` |
| **medium** | valid evidence_ids but not high; stale archive; or issue from source 3 |
| **low** | no direct evidence; source-4 only; weak module mapping — emit only if genuinely informative, omit otherwise |

### Clarifying category enum (`maps_to_clarifying_categories`)

| enum | case-design category |
|------|----------------------|
| `module_confirmation` | Module confirmation |
| `change_type` | Change type |
| `test_types` | Test types |
| `data_needs` | Data needs |
| `success_assertions` | Success assertions |
| `exception_scenarios` | Exception scenarios |
| `target_selection_depth` | Target selection + depth |
| `out_of_scope` | Out of scope |

---

## Step 4 — Validate

```bash
aws risk validate-advisory --change <change-id> --project-dir <project-root>
```

- Fail → `status = failed`; if `mode == required` → STOP before Phase 1.
- Pass → proceed to Step 5.

---

## Step 5 — Update `workflow-state.yaml`

```yaml
phases:
  explore:
    status: done | failed | unavailable
    outputs:
      - explore/context.json
      - explore/advisory.json    # only when done
    hotspots_count: <n>
    watchlist_high_count: <n>
    degraded: <bool from context.json>
    validation_errors: []
```

---

## Final Output (user-facing)

**Do NOT output a step-by-step execution log or compliance checklist.** After writing artifacts, show:

**When `status = done`:**

```
✓ Explore 完成 — explore/advisory.json

[Hotspots]
- HS-001 <area> [high/medium]
- ...

[Watchlist]
- WL-001 <item> [high/medium] → <case-design category>
- ...

（low confidence 项已省略；详见 advisory.json）

下一步：运行 aws-case-design，Skill 将自动读取 advisory。
```

- 仅展示 `confidence: high` 或 `medium` 的项。
- 若所有项均为 `low`（通常因为 degraded 数据），只输出：`⚠ 无历史证据，advisory 未能提供有效信号。建议补充 qa/archive/ 后重试。`
- 不展示文件清单、执行步骤表、合规说明。

**When `status = unavailable`:**

```
⚠ Explore 跳过 — 历史数据不足（<degraded_reasons>）
Phase 1 aws-case-design 将在无 advisory 的情况下继续。
```

**When `status = failed`:**

```
✗ Explore 失败 — <error>
```

---

## Phase 1 gate (summary)

- `status == pending` → Phase 1 **STOP**
- `status == done` → Phase 1 must read advisory; missing files → STOP
- `mode == required` and `status in [failed, unavailable]` → Phase 1 **STOP**
- `mode == advisory` and `status in [skipped, unavailable, failed]` → warning + continue without advisory
