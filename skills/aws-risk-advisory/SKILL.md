---
name: aws-risk-advisory
description: "Phase 0.5 Risk Advisory: run `aws risk context`, then write advisory.json and advisory.md. Use before aws-case-design. Never modify context.json or write case.yaml."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml` if it exists → `phases.risk_advisory`.
2. Derive `<project-root>` (directory containing `.aws/config.yaml`; default = cwd).
3. Read requirement text (user message, file path, or PRD text provided in context).
4. Optional: read `.aws/data-knowledge.yaml`.

**Pre-flight checks — STOP before running CLI if any condition is true:**

| Condition | Action |
|-----------|--------|
| `phases.case_design.status == done` | **STOP** — advisory must run before case design. Tell the user: "当前 change 的 case 已设计完成，Risk Advisory 应在下一个 change 开始时使用，不应事后补跑。" |
| `phases.risk_advisory.status == done` | **STOP** — advisory already complete. Tell the user the advisory path and suggest reading it. |

**After completing work:**

1. Write `qa/changes/<change-id>/risk-advisory/advisory.json`
2. Write `qa/changes/<change-id>/risk-advisory/advisory.md`
3. Run `aws risk validate-advisory --change <change-id> --project-dir <project-root>`
4. On validation failure → set `phases.risk_advisory.status = failed`, record `validation_errors`
5. On success → set `phases.risk_advisory.status = done`, update counts and outputs in `workflow-state.yaml`

---

# Skill: aws-risk-advisory

## Purpose

Produce **Risk Advisory** artifacts (Phase 0.5) from deterministic historical facts + requirement text, before `aws-case-design` begins. The Skill owns the full Phase 0.5 pipeline internally.

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

- CLI **exit != 0** → set `phases.risk_advisory.status = failed`; output one-line error; stop.
- CLI success → read `qa/changes/<change-id>/risk-advisory/context.json`.

---

## Step 2 — Weak-data gate

Check `context.degraded` and `phases.risk_advisory.weak_data_treat_as` (default: `done`):

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

Read `context.json` and requirement text. Produce `advisory.json` + `advisory.md`.

### LLM Hard Rules

1. All numbers, `case_id`, `issue_id`, module names **must** come from `context.json` fields (`evidence[]`, `impact.*`, `historical_issues[]`, `case_signals[]`).
2. Every hotspot / watchlist item **must** reference ≥1 `context.evidence[].id` via `evidence_ids[]`.
3. No `evidence_ids` → item MUST be `confidence: low`. Do not generate hotspot/watchlist items with no evidence.
4. `case_design_guidance` is advisory only — never write case files.
5. Respect `parse_confidence_cap` on evidence — do not exceed cap in item confidence.
6. Use `evidence[]` IDs only — do not use unstable path expressions like `context.test_health[menus].pass_rate`.
7. If `context.staleness.stale == true` → cap all confidence at `medium`; add staleness disclaimer to Executive Summary.

### advisory.json schema (MVP)

Required top-level fields: `schema_version`, `change_id`, `context_ref`, `generated_at`, `executive_summary`, `hotspots`, `watchlist`, `case_design_guidance`, `open_questions_for_case_design`.

See `docs/design/2026-06-19-risk-advisory-spec.md` §5.4 for full schema.

### advisory.md structure

1. **Executive Summary** (≤3 sentences; staleness/degraded disclaimer if applicable)
2. **Hotspots** (table: id · area · confidence · evidence)
3. **Watchlist** (table: id · item · confidence · case-design category)
4. **Case Design Guidance** (priority hints, suggested scenarios, regression focus)

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
  risk_advisory:
    status: done | failed | unavailable
    outputs:
      - risk-advisory/context.json
      - risk-advisory/advisory.json    # only when done
      - risk-advisory/advisory.md      # only when done
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
✓ Risk Advisory 完成 — risk-advisory/advisory.md

[Hotspots]
- HS-001 <area> [high/medium]
- ...

[Watchlist]
- WL-001 <item> [high/medium] → <case-design category>
- ...

（low confidence 项已省略；详见 advisory.md）

下一步：运行 aws-case-design，Skill 将自动读取 advisory。
```

- 仅展示 `confidence: high` 或 `medium` 的项。
- 若所有项均为 `low`（通常因为 degraded 数据），只输出：`⚠ 无历史证据，advisory 未能提供有效信号。建议补充 qa/archive/ 后重试。`
- 不展示文件清单、执行步骤表、合规说明。

**When `status = unavailable`:**

```
⚠ Risk Advisory 跳过 — 历史数据不足（<degraded_reasons>）
Phase 1 aws-case-design 将在无 advisory 的情况下继续。
```

**When `status = failed`:**

```
✗ Risk Advisory 失败 — <error>
```

---

## Phase 1 gate (summary)

- `status == pending` → Phase 1 **STOP**
- `status == done` → Phase 1 must read advisory; missing files → STOP
- `mode == required` and `status in [failed, unavailable]` → Phase 1 **STOP**
- `mode == advisory` and `status in [skipped, unavailable, failed]` → warning + continue without advisory
