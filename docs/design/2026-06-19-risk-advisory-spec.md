# 用例设计前风险研判（Risk Advisory，Phase 0.5）设计规格

> **状态：** 待评审  
> **日期：** 2026-06-19  
> **上游：** [2026-06-15-vnext-quality-pipeline-trd.md](./2026-06-15-vnext-quality-pipeline-trd.md) Principle 1（Case 是唯一入口）、Principle 4（人机协作确认）  
> **总原则：** CLI 产出可复现事实；LLM 只做研判与建议；**不替代** `aws-case-design` 对话；**不写入** `case.yaml`  
> **工程命名：** CLI / 目录 / workflow 字段保留英文（`aws risk context`、`risk-advisory/`、`phases.risk_advisory`）

---

## 1. 范围

### 1.1 做什么

在 `aws-case-design`（Phase 1）**之前**，新增 **Phase 0.5 用例设计前风险研判（Risk Advisory）**：

1. **CLI** `aws risk context` — 聚合 git diff、`qa/cases/`、`qa/archive/` 历史，产出确定性 `context.json`（含稳定 `evidence[]` ID）
2. **Skill** `aws-risk-advisory` — 基于 `context.json` + 需求文本，产出 `advisory.json` / `advisory.md`（仅引用 `evidence_ids`）
3. **Case-design 接入（方案 A）** — 开场 **3–5 条短摘要**；反问优先覆盖 watchlist；内部 **Reconcile**；方案对比与 `proposal.md` 落盘

### 1.2 明确不做

| 项 | 理由 |
|----|------|
| 替代 case-design 反问与用户确认 | TRD Principle 4 |
| 自动生成 / 写入 `case.yaml` | Case 唯一入口在 Phase 1 |
| Phase 0.5 Skill 内联或模拟 case-design 行为 | Phase 0.5 只产出 risk-advisory 产物 |
| 函数调用链（MVP） | 后续与自适应测试联动 |
| case-design 第 5 步 dump 第二份全文风险分析 | 与 advisory 重复 |

### 1.3 适用 run_mode

| run_mode | Risk Advisory |
|----------|---------------|
| `full` | 执行 Phase 0.5 |
| `case-only` | 执行 Phase 0.5 |
| `codegen-only` | **跳过** → `status: skipped` |

---

## 2. 流水线位置

```
Phase 0     Skill Registry Check
    ↓
Phase 0.5   Risk Advisory
    ↓
Phase 1     Case Design（方案 A：短摘要 → 反问 → Reconcile → 方案）
    ↓
Phase 2     Case Review（MVP：high watchlist soft check）
```

---

## 3. Phase 0.5 — Workflow 规格

### 3.1 `phases.risk_advisory` 状态语义（P0-1）

```yaml
phases:
  risk_advisory:
    status: pending | done | skipped | unavailable | failed
    mode: advisory | required    # 默认 advisory
```

| status | 含义 | 如何进入 | 必需产物 | Phase 1 行为 |
|--------|------|----------|----------|--------------|
| `done` | 完整 Risk Advisory 链路成功 | 见 §3.3 状态转移 | `context.json` + `advisory.json` + `advisory.md`（均校验通过） | **必读** advisory |
| `skipped` | 按 run_mode / 配置**主动**跳过 | `codegen-only` 或 orchestrator 显式 skip | 无 | 继续，无 advisory |
| `unavailable` | **数据不足**，且配置为不跑 Skill | 见 §3.3 `weak_data_treat_as: unavailable` | `context.json`（可选 degraded）；**不要求** advisory | `advisory`：warning + 继续；`required`：**STOP** |
| `failed` | CLI 或 Skill **执行/校验失败** | 命令非零退出、schema/evidence 校验失败 | 可能有 partial `context.json`；**不要求** advisory | `advisory`：warning + 继续；`required`：**STOP** |
| `pending` | 尚未执行 | 初始态；orchestrator 漏跑 Phase 0.5 | 无 | **一律 STOP**（合法跳过须显式 `skipped`） |

**产物契约（normative）：**

- `status == done` → `advisory.json` / `advisory.md` **必须存在且 §5.5 校验通过**
- `status == unavailable` → **不要求** `advisory.json` / `advisory.md`（仅 `context.json` 若 CLI 已写出）
- `status == failed` → **不要求** advisory；Phase 1 不得假设 advisory 存在
- `status == skipped` → 不要求 `risk-advisory/` 目录

**与旧稿差异：** `unavailable` ≠ `failed`。前者是「数据不够且策略选择跳过 Skill」；后者是「执行或校验失败」。

### 3.2 Phase 1 门禁逻辑（normative）

Orchestrator / `aws-case-design` **Before doing any work** 按以下顺序判断：

```
read phases.risk_advisory → { status, mode }

# 0. pending — orchestrator 漏跑 Phase 0.5
if status == pending:
  STOP   # 合法跳过必须使用 status=skipped；不得静默进入 Phase 1

# 1. 产物与 status 一致性
if status == done:
  if advisory.json or advisory.md missing:
    STOP   # done 必须带 advisory

if status == unavailable:
  # advisory 缺失是预期；不要求 STOP（除非 mode==required，见下）
  pass

# 2. required 模式硬停
if mode == required and status in [failed, unavailable]:
  STOP

# 3. advisory 模式降级继续
if mode == advisory and status in [skipped, unavailable, failed]:
  record warning in workflow-state.yaml.agent_warnings[]
  continue without advisory   # 跳过短摘要 / Reconcile 中 advisory 部分

# 4. done → 必读
if status == done:
  read advisory.json + advisory.md
  proceed with 方案 A
```

**禁止写法：** `if status in [skipped, unavailable] → continue` 而不检查 `mode`（会与 `required` 冲突）。

### 3.3 Phase 0.5 步骤与状态转移（P0-1）

```
Phase 0.5 — Risk Advisory

Step A — CLI
  → Run: aws risk context --change <id> --project-dir <root> ...
  → On CLI exit != 0:
      status = failed
      outputs = [context.json] if partially written, else []
      STOP Phase 0.5 Skill path

Step B — 弱数据分支（CLI 成功但 no archive / no diff / history 空）
  Read weak_data_treat_as (default: done)

  if weak_data_treat_as == done:
      write degraded context.json (degraded: true, degraded_reasons[])
      → continue Step C (run Skill)

  if weak_data_treat_as == unavailable:
      write degraded context.json if CLI produced one
      skip aws-risk-advisory entirely
      final status = unavailable
      outputs = [risk-advisory/context.json]  # if present
      END Phase 0.5

Step C — Skill（仅 weak_data_treat_as==done 或 数据完整时）
  → Load aws-risk-advisory
  → Write advisory.json, advisory.md
  → Validate advisory (§5.5)
  → On validation fail: status = failed
  → On validation pass: status = done
  → outputs = [context.json, advisory.json, advisory.md]

Step D — Update workflow-state.yaml (status, outputs, counts, degraded)

Boundary:
  Phase 0.5 only produces risk-advisory artifacts.
  The orchestrator may proceed to Phase 1 after workflow-state is updated.
  Phase 0.5 itself must not inline or simulate aws-case-design behavior.
```

**状态转移图（弱数据）：**

```
CLI success + weak data
    ├─ weak_data_treat_as=done
    │     → context.json (degraded)
    │     → aws-risk-advisory → validate
    │     → status=done | failed
    │
    └─ weak_data_treat_as=unavailable
          → context.json (degraded, optional)
          → SKIP Skill
          → status=unavailable (no advisory)
```

### 3.4 降级示例

| 条件 | `weak_data_treat_as` | 跑 Skill? | 最终 status | advisory 要求 | mode=required → Phase 1 |
|------|----------------------|-----------|-------------|---------------|-------------------------|
| 完整 archive + diff | — | 是 | `done` | 必须 | 继续 |
| 有 case 无 archive | `done`（默认） | 是 | `done`（degraded） | 必须 | 继续 |
| 有 case 无 archive | `unavailable` | **否** | `unavailable` | **不要求** | **STOP** |
| CLI 崩溃 | — | 否 | `failed` | 不要求 | **STOP** |
| advisory 校验失败 | — | 已跑 | `failed` | 不要求 | **STOP** |
| `codegen-only` | — | 否 | `skipped` | 不要求 | 继续 |

---

## 4. CLI — `aws risk context`

### 4.1 命令

```bash
aws risk context \
  --change <change-id> \
  --project-dir <project-root> \
  [--diff-base <ref>] \
  [--archive-depth <n>] \
  [--requirement <path>] \
  [--staleness-days <n>]
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `--diff-base` | `main` | git merge-base 对比 ref |
| `--archive-depth` | `10` | 最近 N 个 **archive change**（见 §4.5） |
| `--staleness-days` | `30` | 超过则 `staleness.stale = true`（P1-5） |

### 4.2 输出

```
qa/changes/<change-id>/risk-advisory/context.json
```

仅 CLI 写入；Skill **不得修改** `evidence[]` 与聚合数字。

### 4.3 `.aws/module-map.yaml`（P0-4）

必须支持**一对多**与共享代码路径：

```yaml
rules:
  - pattern: "backend/app/api/v1/menus/**"
    modules: ["menus"]
    confidence: high

  - pattern: "backend/app/core/auth/**"
    modules: ["users", "roles", "menus"]
    confidence: medium
    reason: "auth middleware affects protected modules"

  - pattern: "backend/app/models/**"
    modules: ["users", "roles", "menus"]
    confidence: low
    reason: "shared persistence model"
```

匹配逻辑：

1. 每个 `changed_file` 对全部 `rules` 做 glob 匹配
2. 合并去重得到 `impact.modules[]`（带 confidence、matched_rules）
3. `affected_cases_by_module` = 各 module 的 case_id 列表；`affected_case_ids` = 并集

### 4.4 通过率聚合规则（P0-3）

**Archive 采样：**

- `archive-depth` = 最近 N 个 **`qa/archive/<change-id>/` 目录**（不是 N 个 batch run）
- 排序：`archive_created_at_desc` — 优先 `archive-summary.md` 内 `archived_at`；缺失则用目录 mtime

**Run 采样：** 对每个选中的 archive change，取**最新一次** execution batch（`execution/runs/` 下 mtime 最新，或 `workflow-state` / manifest 中的 batch_id）

**Case 级 pass_rate（按 layer 分开算，api 与 e2e 不合并）：**

```
pass_rate(case_id, layer) = passed_runs / executed_runs

executed_runs = count(status in [passed, failed])
# skipped / not_run / 无该 case 记录的 batch 不计入分母
# xfailed / xpassed：MVP 视为 failed（保守）
```

**Module 级 pass_rate（同 layer）：**

```
module_pass_rate(module, layer)
  = sum(passed_runs for case_id in affected_cases(module))
  / sum(executed_runs for case_id in affected_cases(module))
```

**recent_fail_case_ids（P1-1）：** 在 `archive_window` 内，对每个 sampled archive 取 **latest batch** 后，按 **batch 时间戳倒序** 取最近 **K=3** 个 batch；在这些 batch 中收集 `status==failed` 的 `case_id`，按时间倒序去重。

```
recent_fail_case_ids:
  batches = latest_batch_per_archive(archive_window)
  batches = sort_desc_by_batch_timestamp(batches).take(K=3)
  return distinct case_id where status==failed, order preserved
```

**xfail / xpassed（P1-5）：** MVP **保守**视为 `failed`（计入 executed_runs 分母且计为 fail），因表示非绿或期望不匹配。理由写入 `aggregation_policy.xfail_rationale`。后续可独立 `expected_failure` 类型（如 known product issue 下的受控 xfail），不在 MVP 范围。

### 4.5 `context.json` schema（MVP）

```yaml
schema_version: "1.0"
change_id: "<change-id>"
generated_at: "<ISO-8601>"
requirement_summary: "<optional>"

aggregation_policy:
  archive_depth: 10
  archive_order: "archive_created_at_desc"
  runs_per_archive: "latest_batch_only"
  skipped_counted_in_denominator: false
  layers: ["api", "e2e"]
  xfail_treated_as: "failed"
  xfail_rationale: "MVP conservatively treats xfailed/xpassed as failed (non-green or expectation mismatch). Future: expected_failure for known-issue controlled xfail."
  recent_fail_batch_window_k: 3
  pass_rate_fail_threshold: 0.85   # pass_rate below → eligible for high-confidence test_health evidence

archive_window:
  depth: 10
  archives_sampled: ["2026-06-18-req-004", "2026-06-01-req-003"]
  newest_archive: "2026-06-18"
  oldest_archive: "2026-05-20"

staleness:
  max_age_days: 30
  stale: false

impact:
  diff_base: "main"
  changed_files: ["backend/app/api/v1/menus/menus.py"]
  modules:
    - name: "menus"
      confidence: high
      matched_rules: ["backend/app/api/v1/menus/**"]
    - name: "users"
      confidence: medium
      matched_rules: ["backend/app/core/auth/**"]
      reason: "auth middleware affects protected modules"
  affected_case_ids: ["TC-MENU-001", "TC-MENU-008", "TC-USER-003"]
  affected_cases_by_module:
    menus: ["TC-MENU-001", "TC-MENU-008"]
    users: ["TC-USER-003"]
  affected_test_files: ["tests/api/test_menu_api.py"]

case_signals:
  - case_id: "TC-MENU-008"
    module: "menus"
    priority: "P0"
    automation_status: "automated"
    flaky: false

test_health:
  - module: "menus"
    layer: "api"
    runs_sampled: 8
    pass_rate: 0.75
    recent_fail_case_ids: ["TC-MENU-008"]
    evidence_id: "EV-TEST-HEALTH-MENUS-API"

historical_issues:
  - id: "KPI-001"
    module: "menus"
    endpoint: "GET /api/v1/menu/get"
    severity: "major"
    status: "open"
    evidence_id: "EV-HIST-ISSUE-KPI-001"

# P0-2：稳定 evidence 注册表 — advisory 只能引用此处的 id
evidence:
  - id: "EV-TEST-HEALTH-MENUS-API"
    type: "test_pass_rate"
    module: "menus"
    layer: "api"
    value: 0.75
    runs_sampled: 8
    source: "qa/archive/2026-06-01-req-003/execution/runs/batch-1/api-result.json"

  - id: "EV-HIST-ISSUE-KPI-001"
    type: "historical_issue"
    module: "menus"
    endpoint: "GET /api/v1/menu/get"
    issue_id: "KPI-001"
    source: "qa/archive/2026-06-01-req-003/known-product-issues.md"
    parse_source: "archive_summary_kpi_table"   # 见 §4.6
    parse_confidence_cap: medium

  - id: "EV-DIFF-MENUS-HIGH"
    type: "code_change"
    module: "menus"
    confidence: high
    changed_files: ["backend/app/api/v1/menus/menus.py"]
    source: "git diff"

degraded: false
degraded_reasons: []
```

**禁止：** 在 advisory 中使用 `context.test_health[menus].pass_rate` 类不稳定路径表达式。

### 4.6 `historical_issues` 解析策略（P0-2）

CLI 按 **source priority** 合并 issue；每条 `historical_issues[]` 与 `evidence[]` 须记录 `parse_source` 与 `parse_confidence_cap`。

**MVP source priority：**

| 优先级 | 来源 | `parse_confidence_cap` | 说明 |
|--------|------|------------------------|------|
| 1 | `known-product-issues.json` | **high** | 机器可读 sidecar（推荐） |
| 2 | `known-product-issues.md` YAML frontmatter | **high** | `---` 块内结构化字段 |
| 3 | `archive-summary.md` KPI 表 | **medium** | 模板固定列 |
| 4 | `known-product-issues.md` regex best-effort | **low** | 非结构化 Markdown |

**规则：**

- 仅 source **1–2** 可产出 `parse_confidence_cap: high` 的 `historical_issue` evidence
- source **3** → evidence cap **medium**
- source **4** → evidence cap **low**；LLM **不得**对仅 source-4 证据输出 `confidence: high`
- 解析失败 → **不**导致 CLI `failed`；写入 `degraded_reasons[]`，跳过该条 issue
- 同一 `issue_id` 多源命中 → 取最高优先级 source

**`known-product-issues.json` sidecar 示例（可选，推荐）：**

```json
{
  "issues": [
    {
      "id": "KPI-001",
      "module": "menus",
      "endpoint": "GET /api/v1/menu/get",
      "severity": "major",
      "status": "open"
    }
  ]
}
```

### 4.7 CLI Safety（P0-3）

`aws risk context` 读取 git、写入 `qa/changes/<change-id>/risk-advisory/context.json`。实现 **必须**遵守：

1. **`change-id`** 仅允许 `/^[a-zA-Z0-9._-]+$/`；拒绝路径分隔符与 `..`
2. **所有输出路径** 使用 `path.join(projectRoot, ...)` / safe resolve；写入前 assert 结果仍在 `projectRoot` 内
3. **禁止 shell 拼接** git 命令；使用 `child_process.spawn` / `spawnSync` 与 **参数数组**
4. **`--diff-base`** 作为 git 子进程 argv 传入，不进入 shell
5. **`--requirement`** 路径 `resolve` 后须在 `projectRoot` 内（或显式允许的工作区根）
6. **`--project-dir`** 必须存在且为目录；默认要求含 `.git`，否则 `degraded` + `no_git: true`（不 fatal，除非 `--require-git`）
7. **`change-id` 路径穿越**：输出目录固定为 `qa/changes/<change-id>/risk-advisory/`，不得接受用户提供的任意子路径

违反 1/2/5/7 → CLI **exit != 0**，`status = failed`（不写入 context 或删除 partial 文件）。

---

## 5. Skill — `aws-risk-advisory`

### 5.1 Context Contract

**Before**（仅当 orchestrator 进入 Step C — 见 §3.3，**不**在 `weak_data_treat_as: unavailable` 路径执行）：

1. Read `context.json`
2. Read requirement text
3. Optional: `.aws/data-knowledge.yaml`
4. If `staleness.stale == true` → Skill prompt 要求降低 confidence 上限为 `medium`

**After:**

1. Write `advisory.json`, `advisory.md`
2. Run validation（§5.5）
3. Update `workflow-state.yaml`（status 由校验结果决定）

### 5.2 LLM 硬规则

1. **所有数字、`case_id`、`issue_id`、module 名称** 必须来自 `context.json` 对应字段（`evidence[]`、`impact.*`、`historical_issues[]`、`case_signals[]` 等）
2. **任何 hotspot / watchlist / priority_hint 的风险结论** 必须引用 ≥1 个 `context.evidence[].id`（via `evidence_ids[]`）
3. 无 `evidence_ids` → 该项 `confidence: low`
4. `case_design_guidance` 为建议，不写入 case
5. 遵守 §5.7 confidence 规则；不得突破 evidence 的 `parse_confidence_cap`

### 5.3 Clarifying category enum（P1-2）

与 `aws-case-design` 8 类澄清**语义对齐**，使用 **enum 字符串**，不用魔法数字：

| enum | case-design 类别 |
|------|------------------|
| `module_confirmation` | Module confirmation |
| `change_type` | Change type |
| `test_types` | Test types |
| `data_needs` | Data needs |
| `success_assertions` | Success assertions |
| `exception_scenarios` | Exception scenarios |
| `target_selection_depth` | Target selection + depth |
| `out_of_scope` | Out of scope |

watchlist 示例：

```yaml
maps_to_clarifying_categories:
  - id: "exception_scenarios"
    label: "异常场景"
```

### 5.4 `advisory.json` schema（MVP）

```yaml
schema_version: "1.0"
change_id: "<change-id>"
context_ref: "risk-advisory/context.json"
generated_at: "<ISO-8601>"

executive_summary: "<=3 sentences>"

hotspots:
  - id: "HS-001"
    area: "menus.parent_id validation"
    confidence: high | medium | low
    evidence_ids:
      - "EV-TEST-HEALTH-MENUS-API"
      - "EV-HIST-ISSUE-KPI-001"

watchlist:
  - id: "WL-001"
    item: "parent_id null / self-reference / deep nesting"
    confidence: high
    maps_to_clarifying_categories:
      - id: "exception_scenarios"
        label: "异常场景"
    evidence_ids:
      - "EV-HIST-ISSUE-KPI-001"

case_design_guidance:
  priority_hints:
    - case_id: "TC-MENU-008"
      suggest_priority: "P0"
      evidence_ids: ["EV-TEST-HEALTH-MENUS-API"]
  suggested_scenarios:
    - summary: "parent_id self-reference returns 4xx"
      type: API
      evidence_ids: ["EV-HIST-ISSUE-KPI-001"]
  regression_focus: ["negative", "smoke"]

open_questions_for_case_design: []
```

### 5.5 校验与失败策略（P1-4）

`aws-risk-advisory` 写入后，orchestrator 或 CLI helper **必须**执行：

```
1. advisory.json 符合 JSON schema
2. 所有 evidence_ids[] 存在于 context.json.evidence[].id
3. 所有 case_id 存在于 context.affected_case_ids 或 qa/cases/**
4. 所有 issue 引用存在于 context.historical_issues[].id
5. confidence==high 的项：evidence_ids 非空，且满足 §5.7 high 条件
6. evidence_ids 引用的 parse_confidence_cap 不得被 advisory confidence 突破（high 项不得仅引用 low-cap evidence）

若校验失败:
  → status = failed
  → mode == required: STOP before Phase 1
  → mode == advisory: warning + continue without advisory
```

**注：** 仅当 Phase 0.5 执行了 Skill（`weak_data_treat_as==done` 或数据完整）时才运行 §5.5。`status==unavailable` 时 **跳过** 本节。

### 5.6 Staleness 对 LLM 的约束

当 `context.staleness.stale == true`：

- Skill **不得**输出 `confidence: high`（上限 `medium`）
- `advisory.md` Executive Summary 须注明：「历史 archive 最旧已超过 {max_age_days} 天，结论仅供参考」

### 5.7 Confidence 降级规则（P1-4）

| level | 条件（须同时满足该档所有 applicable 项） |
|-------|------------------------------------------|
| **high** | ≥1 `evidence_ids` 且 evidence 类型为 `historical_issue`（source 1–2）或 `test_health`（pass_rate < `aggregation_policy.pass_rate_fail_threshold`）；且 diff 关联 module confidence ≥ medium；且 `staleness.stale == false` |
| **medium** | 有有效 `evidence_ids`，但不满足 high；或 archive stale；或 historical issue 来自 source 3 |
| **low** | 无 direct historical/test evidence；或仅 source-4 regex issue；或仅弱 module 映射（confidence low） |

校验器（§5.5）对 `confidence: high` 额外检查：evidence 不得全部为 `parse_confidence_cap: low`；`staleness.stale` 时拒绝 high。

---

## 6. Phase 1 接入 — `aws-case-design`（方案 A）

### 6.1 Context Contract

```markdown
Before doing any work:

1. Read workflow-state.yaml → phases.risk_advisory.{status, mode}
2. Apply Phase 1 gate logic (§3.2)
3. If status == done:
     Read risk-advisory/advisory.json and advisory.md
4. Dialogue and user approval remain authoritative over advisory
```

### 6.2 Checklist

| # | 步骤 | 用户可见 |
|---|------|----------|
| 0 | Gate + Read advisory（若 done） | 否 |
| 1–2 | change ID / 探索 QA 上下文 | 否 |
| 3 | 确认 module → **短摘要**（§6.3） | **是** |
| 4 | 反问（优先 watchlist → `exception_scenarios` 等） | **是** |
| 5 | Reconcile（内部；gap 才补问） | 否 |
| 6–11 | 方案 / 批准 / proposal / case YAML | 见 §6.5–6.6 |

### 6.3 开场短摘要（方案 A）

**前提：** `phases.risk_advisory.status == done` 且 advisory 已读。若 status 为 `skipped` / `unavailable` / `failed`，**跳过**本节，直接进入 Checklist #4 反问。

**时机：** Checklist #3 确认 module 后、#4 第一条反问**之前**。

**格式：** 3–5 条 bullet，**不超过一屏**；每条带 confidence（高/中/低）；附 advisory 文件路径。

**模板（agent 输出给用户）：**

```markdown
**Risk Advisory 摘要**（详情：`qa/changes/<change-id>/risk-advisory/advisory.md`）

- **[高]** menus 模块 API 历史通过率 75%；`TC-MENU-008` 近期多次失败
- **[高]** 未关闭 issue KPI-001：`GET /api/v1/menu/get`（workaround 经 list 验证）
- **[中]** 本次 diff 涉及 `backend/app/api/v1/menus/` — 与上述信号同模块

接下来我会基于以上信号逐条确认测试范围（先从 … 开始）。
```

**规则：**

- 仅引用 `advisory.json` / `context.json` 中已有字段（via `evidence_ids` 解析出的 value）
- **不得**粘贴 `advisory.md` 全文或 Hotspots 全表
- `executive_summary` 可压缩为 bullet，须保留 confidence 标签
- 展示后设置 `phases.case_design.risk_advisory_summary_shown: true`（可选）

### 6.4 Reconcile

**时机：** Checklist #5，在 8 类反问完成后、提出覆盖方案（#6）**之前**。

**前提：** 仅当 `status == done` 且已读 `advisory.json` 时执行 Reconcile 的 advisory 对齐部分。无 advisory 时，#5 仅做对话内新信息的内部整理，不引用 advisory ID。

**输入：**

- `risk-advisory/advisory.json`（hotspots、watchlist、open_questions_for_case_design、case_design_guidance）
- 8 类反问已确认的答案（尤其 `exception_scenarios`、`out_of_scope`、`test_types`）

**内部产出（三类清单，不写独立文件、不向用户 dump 风险长文）：**

| 清单 | 含义 | 写入 proposal 的时机 |
|------|------|------------------------|
| `adopted[]` | advisory 中 watchlist / hotspot / priority_hint 已被反问确认采纳 | #8 `Risk Advisory Input` 表：`disposition=adopted` |
| `override[]` | 用户明确排除的 advisory 项；**必须**带 `reason` | #8 表：`disposition=override` + 说明列 |
| `gap[]` | 反问中新发现、但 advisory 未覆盖的风险或范围 | #8 `### Gap from dialogue` 小节 |

**`adopted[]` 条目结构（内存 / checklist，非持久化文件）：**

```yaml
- advisory_id: "WL-001"          # WL-* / HS-* / KPI-* 等
  type: watchlist | hotspot | historical_issue | priority_hint
  note: "确认纳入 negative parent_id 场景"
```

**出口规则：**

- 若 `gap[]` 非空，或 `open_questions_for_case_design` 仍有未决项 → **最多补 1–2 条追问**，然后进入 #6
- 否则 **直接进入 #6**，不做「风险报告返回」

**原 case-design「Internal Risk Analysis」检查项**（业务状态、auth 边界、回归风险等）保留为 Reconcile 时 gap 分析的 internal prompt 附录，不单独对用户输出。

### 6.5 `proposal.md` — Risk Advisory Input

**时机：** Checklist #8 写入 `proposal.md` 时。

**有 advisory（`status == done`）时，`proposal.md` 必须包含：**

```markdown
## Risk Advisory Input

| Advisory ID | 类型 | 处置 | 说明 |
|-------------|------|------|------|
| WL-001 | watchlist | adopted | 方案 B 增加 parent_id negative case |
| HS-001 | hotspot | adopted | TC-MENU-008 提升 P0 |
| KPI-001 | historical_issue | override | 用户确认本次不改 get 接口 |

### Gap from dialogue（advisory 未覆盖）
- 新增批量导入 API — 方案 C 补充 Fuzz endpoint
```

**字段约定：**

| 列 | 取值 |
|----|------|
| Advisory ID | `WL-*`、`HS-*`、`KPI-*`（与 advisory / historical_issues 一致） |
| 类型 | `watchlist` / `hotspot` / `historical_issue` / `priority_hint` |
| 处置 | `adopted` / `override` |
| 说明 | adopted：如何体现在方案中；override：**必须**含 reason |

**无 advisory 时**（`skipped` / `unavailable` / `failed` 且 Phase 1 已继续）：

```markdown
## Risk Advisory Input

_skipped — phases.risk_advisory.status: <status>_
```

`proposal.md` 其余必含章节（如 `## Layer Rationale`）不变。

### 6.6 方案设计要求

**时机：** Checklist #6，向用户提出 2–3 套 QA 覆盖方案。

**每套方案必须说明（表格或 prose）：**

1. **采纳**了哪些 advisory 项（ID 列表，对应 Reconcile `adopted[]`）
2. **排除**了哪些 advisory 项及原因（对应 `override[]`）
3. **如何处理** `gap[]`（新 endpoint、新权限、新数据依赖等）
4. 2–3 套方案之间的 **trade-off**（覆盖深度 vs 成本、API-only vs API+E2E 等）

**示例片段：**

```markdown
### 方案 B（推荐）
- **Adopted:** WL-001, HS-001 → 增加 parent_id negative API case，TC-MENU-008 维持 P0
- **Override:** KPI-001 — 本次不改 GET /api/v1/menu/get
- **Gap:** 批量导入 API → 新增 TC-MENU-API-015 + Fuzz endpoint
- **Trade-off:** 比方案 A 多 2 个 API case，但覆盖历史 fail 点
```

用户批准方案后，Checklist #8–9 落盘：**Reconcile 处置（adopted / override / gap）仅写入 `proposal.md`**；`case.yaml` 只写入用户批准后的 **case 业务字段**，**不得**持久化 advisory ID、`evidence_ids` 或 Reconcile 元数据（§1.2）。

---

## 7. Phase 2 — Case Review（MVP 必做，P1-6）

`aws-case-reviewer` **soft check**（warning，非 blocker）— **纳入 MVP 交付**：

```
IF risk-advisory/advisory.json exists
AND phases.risk_advisory.status == done
AND watchlist[].confidence == high
THEN proposal.md ## Risk Advisory Input MUST list each WL-* as:
     disposition in [adopted, override]
     override MUST include reason
ELSE warning: RISK-ADVISORY-WATCHLIST-UNADDRESSED
```

目的：闭环 Phase 0.5 价值，避免「看过但 proposal 未回应」。

---

## 8. `workflow-state.yaml`

```yaml
phases:
  risk_advisory:
    status: pending | done | skipped | unavailable | failed
    mode: advisory | required
    weak_data_treat_as: done | unavailable    # 默认 done
    outputs: []    # 按 status 填写，见 §3.1 产物契约
    # done:     [context.json, advisory.json, advisory.md]
    # unavailable: [context.json] 或 []
    # failed/skipped: 视 partial 产物
    hotspots_count: 0
    watchlist_high_count: 0
    degraded: false
    validation_errors: []
```

---

## 9. MVP 交付清单

- [ ] `src/risk/` + `aws risk context`（§4.3–4.7）
- [ ] `historical_issues` 解析 + `known-product-issues.json` sidecar 支持（§4.6）
- [ ] `.aws/module-map.yaml` 模板 + 一对多规则
- [ ] `skills/aws-risk-advisory/SKILL.md` + §5.5 校验
- [ ] `aws-workflow` Phase 0.5 + §3.2 门禁
- [ ] `aws-case-design` 方案 A + §3.2 gate
- [ ] **`aws-case-reviewer` soft check（MVP 必做）**
- [ ] JSON schema 文件：`risk-advisory-context.schema.json`、`risk-advisory.schema.json`
- [ ] Unit tests：aggregation_policy、evidence_ids、Phase 1 gate 矩阵

---

## 附录 A：命名（P1-1）

| 层面 | 命名 |
|------|------|
| 产品/文档中文名 | **用例设计前风险研判** |
| 产品/工程英文名 | **Risk Advisory** |
| CLI | `aws risk context` |
| Skill | `aws-risk-advisory` |
| 目录 | `qa/changes/<id>/risk-advisory/` |
| workflow | `phases.risk_advisory` |

## 附录 B：Phase 1 门禁真值表

| mode | status | advisory 缺失 | Phase 1 |
|------|--------|---------------|---------|
| * | pending | — | **STOP** |
| required | done | yes | **STOP** |
| required | done | no | 继续（必读 advisory） |
| required | failed | — | **STOP** |
| required | unavailable | — | **STOP** |
| required | skipped | — | 继续 |
| advisory | done | yes | **STOP** |
| advisory | done | no | 继续（必读 advisory） |
| advisory | failed | — | warning + 继续 |
| advisory | unavailable | yes（预期） | warning + 继续 |
| advisory | skipped | — | 继续 |

## 附录 C：产物 × status 矩阵

| status | context.json | advisory.json/md | 跑 Skill |
|--------|--------------|------------------|----------|
| done | 必须 | 必须 | 是 |
| unavailable | 可选（degraded） | **不要求** | **否** |
| failed | 可选 partial | 不要求 | 可能已跑但校验失败 |
| skipped | 不要求 | 不要求 | 否 |

## 附录 D：参考实现锚点

| 组件 | 路径 |
|------|------|
| ApiResult.cases | `src/core/types.ts` |
| Case clarifying 8 类 | `skills/aws-case-design/SKILL.md` |
| Archive | `skills/aws-archive/SKILL.md` |
