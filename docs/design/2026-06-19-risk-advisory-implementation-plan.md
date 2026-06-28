# 用例设计前风险研判（Risk Advisory）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **状态：** 待批准（生成于 2026-06-19；**2026-06-19 修订：测试本期不做**）  
> **设计依据：** [2026-06-19-risk-advisory-spec.md](./2026-06-19-risk-advisory-spec.md)（唯一 normative 来源）  
> **本文只写「怎么落地」：** 任务拆解、依赖、并行编排、验证 gate、文件清单。设计上的「做什么/为什么」见规格文档，不重复。
>
> **本期 scope 裁剪：** 不新建 `tests/**`、不写 unit/integration test、不维护 `tests/fixtures/risk-advisory/`。验收改为 **`npm run build` + Pilot 手工跑通**。自动化测试列为 **Follow-up R8**（规格 §9 中 test 项延后）。

**Goal:** 在 Phase 1 `aws-case-design` 之前落地 Phase 0.5 Risk Advisory：CLI 聚合可复现事实 → Skill 产出 advisory → workflow / case-design / reviewer 接入。

**Architecture:** `src/risk/` 实现确定性 `aws risk context`（git diff + module-map + archive 聚合 → `context.json` + 稳定 `evidence[]`）；`src/risk/validate.ts` 实现 §5.5 advisory 校验；三个 Skill 文档（`aws-risk-advisory`、workflow Phase 0.5、case-design 方案 A）由 orchestrator 驱动；MVP 不含函数调用链或自适应测试联动。

**Tech Stack:** TypeScript（`aws` CLI）、JSON Schema（Ajv）、js-yaml、child_process.spawn（git）、Cursor Agent Skills（Markdown）。

**预估工期：** 3–4 人周（不含测试）；Pilot SUT 需 ≥3 个 `qa/archive/` 目录用于手工验收。

---

## 计划结构总览

### 分层逻辑

```
事实层 (R0–R2)     → CLI 产出 context + 校验 advisory（确定性、可复现）
智能层 (R3)        → Skill 读 context，写 advisory（LLM）
编排层 (R4)        → workflow Phase 0.5 状态机 + Phase 1 门禁
接入层 (R5–R6)     → case-design / case-reviewer 消费 advisory
验收层 (R7)        → Pilot 手工跑通 + 文档
延后 (R8)          → 自动化测试（本期不做）
```

### Phase 一览

| Phase | 层级 | 做什么 | 主要产出 | 依赖 | 人天（估） | 出口 |
|-------|------|--------|----------|------|------------|------|
| **R0** | 事实层 | JSON Schema + init 模板 | `schemas/*.schema.json`、`src/risk/schemas.ts`、`.aws/module-map.yaml` 模板 | 无 | **2–3** | schema 可 compile；init 能写出 module-map |
| **R1** | 事实层 | `aws risk context` CLI | `src/risk/*`、`src/commands/risk.ts` → `context.json` + `evidence[]` | R0 | **5–8** | Pilot 上 CLI 产出合法 context；`npm run build` |
| **R2** | 事实层 | advisory 校验 CLI | `validate_advisory.ts`、`aws risk validate-advisory` | R0、R1 | **1–2** | 伪造 evidence_id 时校验失败 |
| **R3** | 智能层 | Risk Advisory Skill | `skills/aws-risk-advisory/SKILL.md` | R1（context 契约） | **1–2** | Skill 产出 advisory 并通过 R2 校验 |
| **R4** | 编排层 | Workflow Phase 0.5 | `aws-workflow` Phase 0.5、`workflow-state` 字段、`workflow-schema.yaml` | R2、R3 | **2–3** | 0→0.5→1 顺序自洽；附录 A 门禁与 SKILL 一致 |
| **R5** | 接入层 | Case-design 方案 A | `aws-case-design`：gate / 短摘要 / Reconcile / **proposal only**（advisory 不落 case.yaml） | R4 | **2–3** | §6 对齐；case.yaml 无 WL-/HS-/evidence 元数据 |
| **R6** | 接入层 | Reviewer soft check | `aws-case-reviewer`：`RISK-ADVISORY-WATCHLIST-UNADDRESSED` | R4（可与 R5 并行） | **0.5–1** | reviewer 文档含完整 soft check |
| **R7** | 验收层 | Pilot + 文档 | README、`context.json` / advisory / proposal 样例 | R1–R6 | **1–2** | Pilot checklist 全勾；本期 MVP §13 完成 |
| **R8** | 延后 | 自动化测试 | `tests/unit/risk/*`、integration、fixtures | R7 后任意 | **3–5** | `npm test` 覆盖 aggregation / gate / CLI |

**合计（R0–R7，本期）：** 约 **15–24 人天 ≈ 3–4 人周**（1 人全职；或 2 人并行 R2∥R3、R5∥R6 可压到 **2–3 人周**）。

### 与旧表对照（修订点）

| 旧表述 | 现表述 |
|--------|--------|
| R0 含「测试 fixture」 | R0 仅 **Schema + module-map 模板**；fixture 挪到 **R8** |
| R7「集成测试 + Pilot」 | R7 仅 **Pilot 手工验收 + README**；集成测试挪到 **R8** |
| 验收 = `npm test` | 验收 = **`npm run build` + Pilot checklist** |

### 推荐实施顺序（Batch）

| Batch | Phase | 说明 |
|-------|-------|------|
| 1 | R0 + R1.1–R1.2 | 契约 + safety + git/module-map |
| 2 | R1.3–R1.5 | archive 聚合 + CLI 可跑 |
| 3 | R2 ∥ R3 | 校验器与 Skill 并行 |
| 4 | R4 → R5 ∥ R6 | 先 workflow，再 case-design / reviewer 并行 |
| 5 | R7 | Pilot 端到端 |
| — | R8 | 后续单独 PR |

---

## 0. 前置决策（开工前确认）

| ID | 决策 | 默认 | 影响 |
|----|------|------|------|
| D-1 | Pilot 项目 | `bench/fastapi-vue-admin`（若可用）或团队自有 SUT | 手工验收 + module-map 样例 |
| D-2 | `weak_data_treat_as` 默认值 | `done`（规格 §3.3） | workflow-state 模板与 init 文档 |
| D-3 | `phases.risk_advisory.mode` 默认值 | `advisory` | Phase 1 门禁：failed/unavailable 可降级继续 |
| D-4 | LLM 调用方 | Skill 内 agent 自行调用（与现有 plan/codegen skill 一致） | 不新增 `aws risk advise` CLI 子命令 |
| D-5 | JSON Schema 位置 | `schemas/risk-advisory-context.schema.json`、`schemas/risk-advisory.schema.json` | 与现有 `src/core/schema` 模式对齐 |
| D-6 | **自动化测试** | **本期不做** | 无 `tests/unit/risk/*`、无 integration fixture；Follow-up R8 补测 |

**阻塞项：** 无 M1/M3 类外部依赖；可与 eval 分支并行开发。

---

## 1. 任务依赖图

```
Phase R0 — 契约与模板（全员依赖）
  R0.1 schemas ──> R0.2 module-map 模板
  （R0.F fixtures/tests — Follow-up R8，本期跳过）

Phase R1 — CLI 核心（依赖 R0）
  R1.1 safety + paths
  R1.2 git diff + module-map
  R1.3 archive 采样 + pass_rate
  R1.4 historical_issues 解析
  R1.5 context 组装 + 命令注册
       │
       ├──────────────────────────────┐
       ▼                              ▼
Phase R2 — Advisory 校验器          Phase R3 — Skill 文档
  R2.1 validate.ts (§5.5)            R3.1 aws-risk-advisory/SKILL.md
       │                              │
       └──────────┬───────────────────┘
                  ▼
Phase R4 — Workflow Phase 0.5
  R4.1 workflow-state 字段
  R4.2 aws-workflow SKILL Phase 0.5 步骤
  R4.3 run_mode / codegen-only skip

Phase R5 — Case Design 方案 A（依赖 R4 门禁语义）
  R5.1 gate + Checklist 重编号
  R5.2 短摘要 / Reconcile / proposal 模板
  R5.3 case.yaml 边界（advisory 元数据禁止落盘）

Phase R6 — Case Reviewer soft check（可与 R5 并行）

Phase R7 — Pilot 手工验收 + 文档（依赖 R1–R6）

Phase R8 — 自动化测试（Follow-up，本期不做）
```

**可并行：**

- R2 与 R3 在 R1.5 出口后可并行
- R5 与 R6 在 R4 草稿完成后可并行

---

## 2. Phase R0 — 契约与模板

### R0.1 JSON Schema

**Files:**

- Create: `schemas/risk-advisory-context.schema.json`
- Create: `schemas/risk-advisory.schema.json`
- Create: `src/risk/schemas.ts`（load + compile Ajv — **运行时**供 CLI / `validate-advisory` 使用，非测试专用）

| 任务 | 规格依据 |
|------|----------|
| `context.json` schema：`aggregation_policy`、`archive_window`、`staleness`、`impact`、`case_signals`、`test_health`、`historical_issues`、`evidence[]`、`degraded` | §4.5 |
| `advisory.json` schema：`hotspots`、`watchlist`、`case_design_guidance`、`maps_to_clarifying_categories` enum | §5.3–5.4 |
| `evidence[].id` pattern、`parse_confidence_cap` enum | §4.6 |

- [ ] **Step 1:** 从规格 §4.5 / §5.4 示例 YAML 转为 JSON Schema draft-07
- [ ] **Step 2:** 实现 `src/risk/schemas.ts` 导出 `validateContext` / `validateAdvisory`
- [ ] **Step 3:** 用规格附录示例 JSON 手工跑一次 validate（命令行或临时 script，**不**落库 test 文件）

### R0.2 `.aws/module-map.yaml` 模板

**Files:**

- Create: `src/templates/module-map-yaml.ts`
- Modify: `src/core/generator.ts`（init/repair 写入 `.aws/module-map.yaml`）
- Modify: `README.md`（L1 知识层说明加 module-map 一行 — **仅当 init 已写模板则 README 可随 R7 一并更新**）

- [ ] **Step 1:** 模板含规格 §4.3 三条 rule（high/medium/low confidence）
- [ ] **Step 2:** init `--repair` 可补全缺失 module-map
- [ ] **Step 3:** 文档注释说明一对多匹配语义

**Phase R0 出口 gate:** schema 文件存在 + `schemas.ts` 可 compile + init 产出 module-map。

### R0.F — 测试 Fixture（Follow-up R8，本期跳过）

本期不创建 `tests/fixtures/risk-advisory/**`。Pilot 项目（D-1）即手工验收数据面。

---

## 3. Phase R1 — CLI `aws risk context`

### R1.1 Safety 与路径

**Files:**

- Create: `src/risk/safety.ts`
- Create: `src/risk/paths.ts`

实现规格 §4.7 全部 7 条：

- `change-id` regex `/^[a-zA-Z0-9._-]+$/`
- `safeJoin(projectRoot, ...)` + 写入前 assert 在 root 内
- `--requirement` resolve 边界
- `--project-dir` 存在性；无 `.git` → degraded `no_git`（非 fatal）

- [ ] **Step 1:** 实现 `assertChangeIdSafe` / `resolveOutputDir`
- [ ] **Step 2:** 手工验证 — `change-id` 含 `../` 时 CLI exit != 0

### R1.2 Git diff + Module Map

**Files:**

- Create: `src/risk/git_diff.ts`
- Create: `src/risk/module_map.ts`

| 函数 | 职责 |
|------|------|
| `getChangedFiles(projectRoot, diffBase)` | spawn git merge-base + diff，**argv 数组，无 shell** |
| `matchModules(changedFiles, rules)` | glob 匹配 → `impact.modules[]` 去重合并 confidence |
| `resolveAffectedCases(modules, qaCasesDir)` | `affected_cases_by_module` + `affected_case_ids` |

- [ ] **Step 1:** 实现 git diff（spawn argv 数组）
- [ ] **Step 2:** module-map 一对多：auth 规则命中 → users + roles + menus
- [ ] **Step 3:** 从 `qa/cases/**/case.yaml` 读 `module` / `case_id` 映射

### R1.3 Archive 采样与 pass_rate

**Files:**

- Create: `src/risk/archive_sampler.ts`
- Create: `src/risk/pass_rate.ts`
- Reuse: `src/core/types.ts` — `ApiResult` / `E2eResult` 的 `cases[].status`

规格 §4.4–4.5：

- `archive-depth` = 最近 N 个 `qa/archive/<change-id>/`（`archived_at` → mtime fallback）
- 每 archive 取 latest batch（`execution/runs/` mtime 或 manifest）
- case 级 / module 级 pass_rate **按 layer 分开**
- `skipped` 不计分母；`xfailed`/`xpassed` → failed（保守）
- `recent_fail_case_ids`：K=3 batch 窗口
- `pass_rate < pass_rate_fail_threshold` → 注册 `EV-TEST-HEALTH-*` evidence

- [ ] **Step 1:** 实现 pass_rate 聚合（skipped 不计分母、xfail 保守为 failed）
- [ ] **Step 2:** 实现 `recent_fail_case_ids` K=3 窗口
- [ ] **Step 3:** 实现 `buildTestHealthEvidence()` 写入 `evidence[]`

### R1.4 historical_issues 解析

**Files:**

- Create: `src/risk/historical_issues.ts`

规格 §4.6 source priority 1→4：

1. `known-product-issues.json` → cap **high**
2. `.md` YAML frontmatter → cap **high**
3. `archive-summary.md` KPI 表 → cap **medium**
4. regex best-effort → cap **low**

- 同 `issue_id` 取最高优先级 source
- 解析失败 → `degraded_reasons[]`，不 fatal

- [ ] **Step 1:** 实现 source priority 1→4 与 issue_id 去重合并
- [ ] **Step 2:** 解析失败写入 degraded，CLI 仍 exit 0

### R1.5 Context 组装与命令注册

**Files:**

- Create: `src/risk/context_builder.ts`
- Create: `src/risk/types.ts`
- Create: `src/commands/risk.ts`
- Modify: `src/cli.ts` — `registerRiskCommand`

```bash
aws risk context \
  --change <change-id> \
  --project-dir <root> \
  [--diff-base main] \
  [--archive-depth 10] \
  [--requirement <path>] \
  [--staleness-days 30]
```

输出：`qa/changes/<change-id>/risk-advisory/context.json`

弱数据检测（规格 §3.3 Step B）：

- 无 archive / 无 diff / history 空 → `degraded: true` + `degraded_reasons[]`
- CLI **始终 exit 0**（除非 §4.7 safety 违规）；weak 分支由 orchestrator 读 `degraded` 决定 Skill 是否运行

- [ ] **Step 1:** 在 Pilot 项目跑 `aws risk context`，检查 `context.json` 字段与 `evidence[]` ID
- [ ] **Step 2:** 手工验证 — 无 archive 时 `degraded: true` 且 exit 0
- [ ] **Step 3:** 手工验证 — 非法 change-id → exit != 0
- [ ] **Step 4:** `npm run build` 通过

**Phase R1 出口 gate:** Pilot 上 `aws risk context` 产出合法 `context.json`；`npm run build` 通过。

---

## 4. Phase R2 — Advisory 校验器（§5.5）

**Files:**

- Create: `src/risk/validate_advisory.ts`
- Create: `src/commands/risk.ts` 子命令 `aws risk validate-advisory`（推荐 — 供 orchestrator 确定性校验）

校验规则（规格 §5.5 + §5.7）：

1. advisory.json 符合 schema
2. 所有 `evidence_ids[]` ∈ `context.evidence[].id`
3. 所有 `case_id` ∈ `context.affected_case_ids` 或 `qa/cases/**`
4. issue 引用 ∈ `context.historical_issues[].id`
5. `confidence: high` 满足 §5.7 条件
6. high 项不得仅引用 `parse_confidence_cap: low` evidence
7. `staleness.stale` 时拒绝 high confidence

- [ ] **Step 1:** 实现 §5.5 六条 + §5.7 staleness 规则
- [ ] **Step 2:** 导出 `{ valid, errors[] }` 供 workflow 写 `validation_errors`
- [ ] **Step 3:** 手工验证 — 故意伪造 `evidence_id` 时 `validate-advisory` 失败

**Phase R2 出口 gate:** 校验器逻辑与 §5.5 对齐；Pilot 上可对真实 advisory 跑通 CLI。

---

## 5. Phase R3 — Skill `aws-risk-advisory`

**Files:**

- Create: `skills/aws-risk-advisory/SKILL.md`
- Modify: `src/commands/skill.ts` 或 skill registry（若存在 central list）— 注册新 skill
- Modify: `skills/aws-workflow/SKILL.md` — Phase 0 Skill Registry 列表加入 `aws-risk-advisory`

SKILL.md 必须包含：

| 章节 | 内容 |
|------|------|
| Context Contract | §5.1 Before/After；**禁止**修改 `context.json` |
| LLM 硬规则 | §5.2 六条 |
| 输入 | `risk-advisory/context.json`、requirement、可选 `.aws/data-knowledge.yaml` |
| 输出 | `advisory.json`、`advisory.md` |
| Staleness | §5.6 — stale 时 confidence 上限 medium + 摘要免责声明 |
| 校验 | 写入后调用 `aws risk validate-advisory` 或内联 §5.5 checklist |
| `advisory.md` 结构 | Executive Summary、Hotspots、Watchlist、Case Design Guidance（可读版） |

- [ ] **Step 1:** 从规格 §5 复制 normative 段落，改写成 skill 指令语气
- [ ] **Step 2:** 加入 `watchlist.maps_to_clarifying_categories` enum 表（§5.3）
- [ ] **Step 3:** workflow Phase 0 registry 列表更新
- [ ] **Step 4:** 人工走读 — agent 能否仅依赖 SKILL 完成写入 + 自校验

**Phase R3 出口 gate:** skill 可被 `aws skill list`（若有）或 workflow registry 识别；样例 run 产出符合 schema 的 advisory。

---

## 6. Phase R4 — Workflow Phase 0.5

**Files:**

- Modify: `skills/aws-workflow/SKILL.md` — 插入 **Phase 0.5 Risk Advisory**（在 Phase 0 与 Phase 1 之间）
- Modify: `docs/design/workflow-schema.yaml` — 新增 `risk_advisory` phase 节点（draft，与现有 orchestration 对齐）
- Modify: `src/orchestration/` — 若 engine 已读 workflow-state phases，扩展类型（可选 MVP：仅 skill 文档驱动）

### 4.1 workflow-state 字段

规格 §8：

```yaml
phases:
  risk_advisory:
    status: pending | done | skipped | unavailable | failed
    mode: advisory | required
    weak_data_treat_as: done | unavailable
    outputs: []
    hotspots_count: 0
    watchlist_high_count: 0
    degraded: false
    validation_errors: []
```

### 4.2 Phase 0.5 步骤（写入 workflow SKILL）

规格 §3.3 逐步：

```
Step A — aws risk context
Step B — weak_data 分支（weak_data_treat_as）
Step C — aws-risk-advisory + validate
Step D — update workflow-state
```

### 4.3 run_mode 规则

| run_mode | risk_advisory |
|----------|---------------|
| `full` / `case-only` | 执行 Phase 0.5 |
| `codegen-only` | `status: skipped` |

### 4.4 Phase 1 门禁引用

在 Phase 1 — Case Design 开头链式引用 §3.2 真值表（附录 B）。

- [ ] **Step 1:** workflow SKILL 插入 Phase 0.5 完整步骤 + 状态转移图
- [ ] **Step 2:** Phase Overview 表增加 Phase 0.5 行
- [ ] **Step 3:** `codegen-only` skip 逻辑与 `phases.risk_advisory.status=skipped`
- [ ] **Step 4:** 对照附录 A 真值表人工走读 workflow 门禁段落（本期不写 gate unit test）

**Phase R4 出口 gate:** workflow 文档自洽（Phase 0 → 0.5 → 1 顺序无冲突）；附录 A 真值表与 SKILL 一致。

---

## 7. Phase R5 — `aws-case-design` 方案 A

**Files:**

- Modify: `skills/aws-case-design/SKILL.md`

| 改动 | 规格 |
|------|------|
| **Before doing any work** — 读 `phases.risk_advisory`，应用 §3.2 门禁 | §6.1 |
| Checklist #0 Gate + Read advisory | §6.2 |
| Checklist #3 后 — **3–5 条 Risk Advisory 短摘要** | §6.3 |
| Checklist #4 — 反问优先 watchlist / `exception_scenarios` | §6.2 |
| Checklist #5 — **Reconcile**（`adopted[]` / `override[]` / `gap[]`）替换原「Analyze risks internally」 | §6.4 |
| Checklist #6 — 方案须 cite adopted/override/gap | §6.6 |
| Checklist #8 — `proposal.md` 必含 `## Risk Advisory Input` | §6.5 |
| Checklist #9 — `case.yaml` **仅**写入用户批准后的 case 字段（见 **R5.3 边界**） | §1.2、§6.4 |
| 无 advisory 时 proposal 占位 `_skipped — status: <status>_` | §6.5 |

### R5.3 `case.yaml` 边界（normative — 防止 advisory 污染 Case 入口）

规格 §1.2：**不写入 `case.yaml`**。Reconcile 的 `adopted[]` / `override[]` / `gap[]` 是 **Phase 1 过程内存结构**，落盘位置 **仅** `proposal.md`（`## Risk Advisory Input` + Gap 小节），**不得**进入 case delta。

**禁止（MUST NOT）：**

```
case.yaml MUST NOT persist:
  - advisory IDs (WL-*, HS-*, KPI-* as advisory trace fields)
  - evidence_ids[]
  - adopted[] / override[] / gap[] (or equivalent nested blocks)
  - Risk Advisory Input / risk_advisory / advisory_ref 等元数据块

Only user-approved final case fields may be written to case.yaml
(priority, type, test_condition, automation, risk.level 等业务字段 — 且须来自对话确认，非 advisory 原文拷贝).

Risk Advisory disposition (adopted / override / gap) is persisted ONLY in proposal.md.
```

**允许：** case-design 根据已采纳的 advisory **语义**调整 case 内容（例如因 WL-001 新增 negative API case、因 HS-001 将 `TC-MENU-008` 标为 P0），但 case 条目中 **不得**保留 advisory 溯源字段。

**Readiness check（Checklist #10 自审 + handoff 前）：**

```
generated case.yaml MUST NOT contain:
  - top-level or per-case keys: risk_advisory, advisory_input, evidence_ids, adopted, override, gap
  - string values matching advisory ID patterns used as trace metadata: WL-*, HS-* (except when coincidentally part of unrelated business text — prefer rewording)
  - pasted "## Risk Advisory Input" table content or proposal-only Reconcile blocks
```

违规 → **STOP**，修正 case delta 后再 handoff；不得将 advisory 元数据「方便追溯」写入 case。

**禁止保留的写法：**

- Checklist #5 对用户 dump 全文风险分析
- 跳过 gate 直接进入 module 确认
- Checklist #9 将 Reconcile 结果或 `WL-*` / `HS-*` 写入 `case.yaml`（仅 proposal 落盘）

- [ ] **Step 1:** 重编号 Checklist（0–11），更新 mermaid 流程图若有
- [ ] **Step 2:** 加入短摘要模板（§6.3 markdown 块）
- [ ] **Step 3:** 加入 Reconcile 三类清单结构 + 出口规则（明确 **memory-only → proposal.md only**）
- [ ] **Step 4:** proposal.md 模板增加 Risk Advisory Input 表示例
- [ ] **Step 5:** readiness check — done 时 proposal 必有 Risk Advisory Input 表
- [ ] **Step 6:** readiness check — case.yaml 无 advisory / evidence_ids / WL-* / HS-* 元数据（§R5.3）
- [ ] **Step 7:** Forbidden 段增加「不得写入 case.yaml」与 proposal-only disposition 说明

**Phase R5 出口 gate:** case-design SKILL 与规格 §6 对齐；含 **R5.3 case.yaml 边界**；grep case-design SKILL 无「advisory 落 case」暗示；Pilot 样例 case.yaml 无 WL-/HS- 溯源字段。

---

## 8. Phase R6 — `aws-case-reviewer` soft check

**Files:**

- Modify: `skills/aws-case-reviewer/SKILL.md`

规格 §7（MVP 必做）：

```
IF advisory.json exists AND status==done AND watchlist[].confidence==high
THEN proposal.md ## Risk Advisory Input MUST list each WL-* as adopted|override
     override MUST include reason
ELSE warning: RISK-ADVISORY-WATCHLIST-UNADDRESSED
```

- warning 写入 review JSON findings，**非 blocker**
- finding code: `RISK-ADVISORY-WATCHLIST-UNADDRESSED`

- [ ] **Step 1:** 在 reviewer checklist 增加 Risk Advisory 段
- [ ] **Step 2:** 定义 finding 结构与 severity=`low` / `human_review_required=false`
- [ ] **Step 3:** 示例 review JSON 片段

**Phase R6 出口 gate:** reviewer 文档含完整 soft check 伪代码；与 §7 一致。

---

## 9. Phase R7 — Pilot 手工验收与文档

> **说明：** 原 R7.1 自动化集成测试移至 **Follow-up R8**。

### R7.1 Pilot 手工验收清单

在 Pilot SUT（D-1）上跑完整 Phase 0.5 → Phase 1 对话：

- [ ] `aws risk context --change <pilot-id>` 产出 `context.json`（有 archive 时 `degraded=false`）
- [ ] `aws risk validate-advisory` 对 Skill 产出的 advisory 通过
- [ ] `evidence[]` ID 在 advisory 中被引用
- [ ] weak data + `weak_data_treat_as=unavailable` → status unavailable，无 advisory
- [ ] case-design 展示 3–5 条短摘要
- [ ] proposal.md 含 Risk Advisory Input 表
- [ ] **case.yaml 无 advisory 元数据**（无 `evidence_ids`、`WL-*`/`HS-*` 溯源字段、`risk_advisory` 块）
- [ ] case-reviewer 对遗漏 high watchlist 发出 warning
- [ ] 附录 A 门禁：至少 spot-check `pending` / `required+failed` / `advisory+failed` 三种

### R7.2 文档

**Files:**

- Modify: `README.md` — CLI 增加 `aws risk context` 一行；Phase 0.5 流水线说明（简短）
- 规格文档 §9 MVP checklist — 实施完成后逐项打勾

**Phase R7 出口 gate:** `npm run build` 通过 + Pilot 验收清单完成 + 本期 MVP §13 清单全 [x]。

---

## 10. 文件总览

### 本期（约 22 路径，无 `tests/**`）

| 路径 | 操作 | Phase |
|------|------|-------|
| `schemas/risk-advisory-context.schema.json` | Create | R0 |
| `schemas/risk-advisory.schema.json` | Create | R0 |
| `src/risk/types.ts` | Create | R1 |
| `src/risk/safety.ts` | Create | R1 |
| `src/risk/paths.ts` | Create | R1 |
| `src/risk/git_diff.ts` | Create | R1 |
| `src/risk/module_map.ts` | Create | R1 |
| `src/risk/archive_sampler.ts` | Create | R1 |
| `src/risk/pass_rate.ts` | Create | R1 |
| `src/risk/historical_issues.ts` | Create | R1 |
| `src/risk/context_builder.ts` | Create | R1 |
| `src/risk/schemas.ts` | Create | R0 |
| `src/risk/validate_advisory.ts` | Create | R2 |
| `src/commands/risk.ts` | Create | R1 |
| `src/cli.ts` | Modify | R1 |
| `src/templates/module-map-yaml.ts` | Create | R0 |
| `src/core/generator.ts` | Modify | R0 |
| `skills/aws-risk-advisory/SKILL.md` | Create | R3 |
| `skills/aws-workflow/SKILL.md` | Modify | R4 |
| `skills/aws-case-design/SKILL.md` | Modify | R5 |
| `skills/aws-case-reviewer/SKILL.md` | Modify | R6 |
| `docs/design/workflow-schema.yaml` | Modify | R4 |

### Follow-up R8（测试，本期不做）

| 路径 | 说明 |
|------|------|
| `tests/unit/risk/*.test.ts` | aggregation、evidence_ids、phase1_gate、validate |
| `tests/integration/commands/risk_context.test.ts` | CLI 集成 |
| `tests/integration/risk_advisory_pipeline.test.ts` | 端到端 pipeline |
| `tests/fixtures/risk-advisory/**` | 最小项目 + archive 样例 |
| case-design readiness | generated case.yaml 不得含 advisory / evidence_ids / WL-* / HS-* 元数据 |

---

## 11. Subagent 派发建议

| 批次 | 任务包 | 依赖 |
|------|--------|------|
| **Batch 1** | R0 全量 + R1.1–R1.2 | 无 |
| **Batch 2** | R1.3–R1.5 | Batch 1 |
| **Batch 3** | R2 + R3 | Batch 2 |
| **Batch 4** | R4 + R5 + R6（三 skill 可三 agent 并行） | Batch 3 |
| **Batch 5** | R7 Pilot 手工验收 + README | Batch 4 |

每批出口跑 `npm run build`；Batch 5 在 Pilot 跑一轮真实 workflow（无自动化 test gate）。

---

## 12. 风险与缓解

| 风险 | 缓解 |
|------|------|
| Pilot archive 不足 → 大量 degraded | Pilot 补 3+ archive；默认 `weak_data_treat_as=done`；本期无 fixture 回归 |
| 无自动化测试 → 回归靠人工 | Follow-up R8 补测；本期改 CLI 后必须重跑 Pilot checklist |
| module-map 未维护 → 低 confidence 映射 | init 模板 + doctor 检查 `.aws/module-map.yaml` 存在（可选 follow-up） |
| LLM 伪造 evidence_id | §5.5 校验 + Skill 硬规则；validate 失败 → status failed |
| workflow SKILL 体积膨胀 | Phase 0.5 引用规格 §3 而非全文复制；附录 B 真值表链式引用 |
| git 在非 git 目录失败 | §4.7 degraded `no_git`，不 fatal |

---

## 13. MVP 完成定义（本期 scope）

- [ ] `src/risk/` + `aws risk context`（§4.3–4.7）
- [ ] `historical_issues` 解析 + `known-product-issues.json` sidecar（§4.6）
- [ ] `.aws/module-map.yaml` 模板 + 一对多规则
- [ ] `skills/aws-risk-advisory/SKILL.md` + §5.5 校验（`validate-advisory` CLI）
- [ ] `aws-workflow` Phase 0.5 + §3.2 门禁
- [ ] `aws-case-design` 方案 A + §3.2 gate + **R5.3 case.yaml 边界**
- [ ] `aws-case-reviewer` soft check
- [ ] JSON schema 文件（`schemas/*.schema.json`）
- [ ] Pilot 手工验收清单（§9 R7.1）全部勾选

**延后（Follow-up R8，规格 §9 原 test 项）：**

- [ ] unit tests：aggregation、evidence_ids、Phase 1 gate 矩阵
- [ ] integration tests + `tests/fixtures/risk-advisory/**`

---

## 附录 A：Phase 1 门禁真值表（文档 / 未来 R8 测试用例源）

摘自规格附录 B — Follow-up 时写入 `tests/unit/risk/phase1_gate.test.ts`：

| status | mode | 期望 Phase 1 |
|--------|------|--------------|
| pending | * | STOP |
| done | * | 继续（缺 advisory 文件 → STOP） |
| skipped | advisory | 继续，无 advisory |
| skipped | required | 继续，无 advisory |
| unavailable | advisory | warning + 继续 |
| unavailable | required | STOP |
| failed | advisory | warning + 继续 |
| failed | required | STOP |

---

## 附录 B：建议 commit 粒度

1. `feat(risk): add JSON schemas and module-map template`
2. `feat(risk): implement aws risk context CLI core`
3. `feat(risk): historical issues parser and evidence registry`
4. `feat(risk): advisory validator and validate-advisory command`
5. `feat(skills): add aws-risk-advisory and workflow Phase 0.5`
6. `feat(skills): case-design Risk Advisory integration (方案 A)`
7. `feat(skills): case-reviewer RISK-ADVISORY-WATCHLIST soft check`

（Follow-up）`test(risk): unit/integration tests and fixtures`
