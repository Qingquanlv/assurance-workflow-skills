---
name: aws-explore
description: "Phase 1.1 Explore: run `aws risk context`, shallow-read source code, synthesize advisory.json, then collect answers to open_questions one at a time. Use before aws-case-design. Artifacts live under explore/ (context.json, advisory.json). Never modify context.json or write case.yaml."
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

| `degraded` | `weak_data_treat_as` | `degraded_reasons` | Action |
|------------|----------------------|--------------------|--------|
| false | any | — | Continue to Step 3 (source read) |
| true | `done` | partial (not all 3) | Continue to Step 3; cap confidence at `medium` |
| true | `unavailable` | any | Skip Steps 3–5 → `status = unavailable` → END |
| true | any | all 3 present | **Do NOT immediately go to unavailable** — proceed to Step 3 to attempt source code read first |

**Revised hard rule:** If ALL THREE of `no_diff`, `no_cases`, `no_history` are present in `degraded_reasons`, proceed to Step 3 and attempt source code read. Only if source code is also empty (no routes, no models, empty project directory) does `status = unavailable` apply. Source code structure is valid evidence; do not fabricate unavailability when the codebase is readable.

When `status = unavailable` (confirmed after Step 3): update `workflow-state.yaml`, output one-line notice, stop.

---

## Step 3 — Shallow source code read (新增)

Read source code structure to supplement or replace missing historical evidence. This step is always executed unless `weak_data_treat_as = unavailable`.

### What to read

Use Read/Grep tools. Do NOT read test source files or business logic implementations.

**Backend (find and read):**
- Route definition files: search for `routes/`, `router.ts`, `*router*.ts`, `*.routes.ts`, `*controller*.ts` under the target module directory.
  - Extract: HTTP method, path pattern, handler name per route.
- Model/entity definition files: search for `models/`, `entities/`, `*model*.ts`, `*entity*.ts`, `*schema*.ts` under the target module directory.
  - Extract: field names, types, key constraints (required, unique, FK/relation).
- RBAC/permission configuration: search for `rbac`, `permission`, `guard`, `role` files.
  - Extract: role names or permission enum values relevant to the module.

**Frontend (directory structure only — do NOT read component internals):**
- List the target module's directory hierarchy and file names (e.g. `src/views/<module>/`).
- Do NOT read component/page source code.

**Not read (intentionally out of scope):**
- Existing test source files (`tests/`, `test/`, `*.spec.ts`, `*.test.ts`) — these belong to aws-test-author.
- Business logic implementations (service layer, use-case implementations).
- Configuration/environment files.

### Evidence produced from source code

Each structural fact found becomes an evidence entry:

```json
{
  "id": "SC-001",
  "source": "source_code",
  "type": "api_route | model_field | rbac_role | frontend_structure",
  "description": "POST /api/v1/users — createUser handler",
  "parse_confidence_cap": "medium"
}
```

All `source: "source_code"` evidence has `parse_confidence_cap: "medium"` — code structure proves interface shape, not failure history.

### Empty source gate

After reading, if **no** routes, models, or frontend structure were found (project directory is empty or unreadable):
- AND historical data was also empty (all 3 degraded_reasons present)
- THEN → `status = unavailable`; update `workflow-state.yaml`; output one-line notice; stop.

Otherwise continue to Step 4.

### evidence_inventory update

Move actually-read items from `not_inspected` to `available`:
- If routes were read → `api_routes` moves to `available`.
- If model files were read → `rbac_<module>_model` moves to `available`.
- If frontend structure was listed → add `frontend_structure` to `available`.
- Test source files always remain in `not_inspected`.

---

## Step 4 — LLM synthesis

Read `context.json`, requirement text, **and source code evidence collected in Step 3**. Produce `advisory.json` only.

### LLM Hard Rules

1. All numbers, `case_id`, `issue_id`, module names **must** come from `context.json` fields (`evidence[]`, `impact.*`, `historical_issues[]`, `case_signals[]`) **or from source code evidence (SC-* IDs) collected in Step 3**.
2. Every hotspot / watchlist item **must** reference ≥1 evidence ID (`context.evidence[].id` or Step 3 `SC-*` ID) via `evidence_ids[]`.
3. No `evidence_ids` → item MUST be `confidence: low`. Do not generate hotspot/watchlist items with no evidence.
4. `case_design_guidance` is an **evidence-anchored channel** — never write case files. When ALL evidence (historical AND source code) is empty, set `priority_hints`, `suggested_scenarios`, and `regression_focus` to `[]`. Do **not** fill them with generic advice — generic "at least cover" guidance belongs exclusively in `minimum_required_coverage`; degraded disclaimers belong exclusively in `executive_summary`.
5. Respect `parse_confidence_cap` on evidence — do not exceed cap in item confidence. All `source: "source_code"` evidence has cap `medium`; do not assign `high` confidence to any item backed only by SC-* evidence.
6. Use `evidence[]` IDs only — do not use unstable path expressions like `context.test_health[menus].pass_rate`.
7. If `context.staleness.stale == true` → cap all confidence at `medium`; add staleness disclaimer to Executive Summary.
8. `evidence_inventory` and `minimum_required_coverage` are top-level metadata fields. Do **not** place them under `hotspots` or `watchlist`.
9. In degraded / weak-data conditions, keep `hotspots` and `watchlist` empty unless there is direct `evidence_ids[]` support (SC-* IDs from Step 3 count); never turn `minimum_required_coverage` into an evidence-backed hotspot.
10. **Channel separation (hard):** each piece of output content has exactly one home.
    - "Why the advisory is limited" → `executive_summary` only.
    - "What evidence was / wasn't available" → `evidence_inventory` only.
    - "What to cover at minimum" → `minimum_required_coverage` only.
    - "Prioritised risk signals from evidence" → `hotspots` / `watchlist` / `case_design_guidance` (when evidence exists).
    - "Open questions for case-design" → `open_questions_for_case_design` only.
    Duplicating the same content across channels is a violation.
11. When producing items backed exclusively by `source: "source_code"` evidence (SC-* IDs), add `"source_basis": "code_structure_only"` to each such `case_design_guidance` item, and note in `executive_summary` that results are derived from code structure analysis with no historical execution data.
12. `open_questions_for_case_design` items are advisory draft only — leave `answer` and `answered_via` as `null`; they are populated in Step 5.

### advisory.json schema (MVP)

Required top-level fields: `schema_version`, `change_id`, `context_ref`, `generated_at`, `executive_summary`, `hotspots`, `watchlist`, `evidence_inventory`, `case_design_guidance`, `minimum_required_coverage`, `open_questions_for_case_design`.

See `schemas/explore-advisory.schema.json` for the MVP advisory shape.

### Required degraded-output metadata

When advisory is degraded and evidence-backed signals are unavailable, `hotspots` and `watchlist` remain empty arrays, `case_design_guidance` sub-arrays are all `[]`, and the advisory MUST still populate `evidence_inventory` and `minimum_required_coverage` per the rules below.

#### evidence_inventory — derivation rules

Three buckets; populate dynamically for every change, do **not** copy-paste the example verbatim.

| Bucket | Definition | Rule |
|--------|-----------|------|
| `available` | Data that **was read and used** by this advisory | Always: `requirement_text`, `explore_context`. Add route/model/frontend items here **only if actually read in Step 3**. |
| `missing` | Data the aggregator **tried to collect** (within its scope) but found empty or unavailable | = fields that are empty in `context.json` and whose absence is a degraded_reason (`no_diff` → `git_diff`/`changed_files`; `no_history` → `historical_issues`/`previous_failure_analysis`/`known_product_issues`). |
| `not_inspected` | Data that **exists and could be read** but was **not read in this run** | Always: `existing_tests` (source files), `api_schema` (live schema). Move `api_routes` / `rbac_<module>_model` / `frontend_structure` to `available` if Step 3 actually read them. |

> **Caution — `existing_tests` ambiguity:** test *source files* are always `not_inspected`; test *health signals* (`test_health[]` aggregated from archive) may be `missing` if the archive returned no data. These are different things — do not conflate them.

*Example (menu-management, no diff, no history, routes+model read in Step 3):*
```json
"evidence_inventory": {
  "available": ["requirement_text", "explore_context", "api_routes", "rbac_menu_model"],
  "missing": ["git_diff", "changed_files", "historical_issues",
              "previous_failure_analysis", "known_product_issues"],
  "not_inspected": ["existing_tests", "api_schema"]
}
```

*Example (menu-management, no diff, no history, source also empty):*
```json
"evidence_inventory": {
  "available": ["requirement_text", "explore_context"],
  "missing": ["git_diff", "changed_files", "historical_issues",
              "previous_failure_analysis", "known_product_issues"],
  "not_inspected": ["existing_tests", "api_routes", "api_schema", "rbac_menu_model"]
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

## Step 5 — Collect open_questions answers (一次一问交互，新增)

After writing the advisory draft, check `open_questions_for_case_design[]`:

- If empty → skip this step, proceed to Step 6.
- If non-empty → ask the user one question at a time, in array order.

**Question format:**

```
探索发现一个需要确认的问题（<i>/<N>）：

<question text>

<if options present, list them as choices>

请回答，或输入"跳过"（此问题将留给 case-design 阶段处理）。
```

- User provides answer → write to `open_questions_for_case_design[i].answer` (string), set `answered_via = "explore"`.
- User inputs "跳过" (or equivalent) → leave `answer = null`, `answered_via = null`.
- After all questions are asked (or user skips ≥3 in a row), output:
  `"已记录回答，继续生成最终 advisory。"` and proceed to Step 6.

Answers are persisted into `advisory.json` — `aws-case-design` will skip re-asking answered questions.

---

## Step 6 — Validate

```bash
aws risk validate-advisory --change <change-id> --project-dir <project-root>
```

- Fail → `status = failed`; if `mode == required` → STOP before Phase 1.
- Pass → proceed to Step 7.

---

## Step 7 — Update `workflow-state.yaml`

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
    source_code_read: <bool>         # true if Step 3 found and read any source files
    open_questions_answered: <n>     # count of questions answered in Step 5
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
- 若所有项均为 `low` 但有代码 evidence（SC-* 证据），输出：`⚠ 无历史证据；advisory 基于代码结构合成，置信度上限 medium。`
- 若所有项均为 `low` 且无任何 evidence，输出：`⚠ 无历史证据，advisory 未能提供有效信号。建议补充 qa/archive/ 后重试。`
- 不展示文件清单、执行步骤表、合规说明。

**When `status = unavailable`:**

```
⚠ Explore 跳过 — 历史数据不足（<degraded_reasons>），源码也为空
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
