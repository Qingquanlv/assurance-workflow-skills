---
name: aws-api-plan
description: Use when a QA Case Delta contains API automation cases and you need to generate reviewable plan files before writing any test code. Triggers on: "generate API plan", "M3 Stage 1", "api-plan.md", "review before codegen", "api planning". Only processes API cases with automation.required = true. Never generates test code.
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.case_review.status == pass` (gate must be cleared).
3. Read **Required** input files from disk:
   - `qa/changes/<change-id>/.qa.yaml`
   - `qa/changes/<change-id>/proposal.md`
   - `qa/changes/<change-id>/cases/**/case.yaml`
   - If any required file is missing, **STOP** and report.
4. Read **Optional** input files from disk (missing = warning, do not STOP):
   - `.aws/config.yaml`
   - `.aws/data-knowledge.yaml` (if missing, proceed and generate proposal — see Data Knowledge Layer Rules)
   - Backend source files (for endpoint / schema confirmation)
   > **data-knowledge 分层规则：**
   > - `aws-api-plan` 阶段：`.aws/data-knowledge.yaml` 缺失不阻断 planning；生成 `data-knowledge.proposal.yaml`；Plan Readiness 可为 `ready_with_warnings`；**Codegen Readiness 必须为 `not_ready`**（无论 case 是否有 data 需求）。
   > - `aws-api-codegen` 阶段：`.aws/data-knowledge.yaml` **必须存在**。`data-knowledge.proposal.yaml` 仅供参考，不可替代。
5. Use files as the sole source of truth.

**After completing work:**

1. Write output files:
   - `qa/changes/<change-id>/plans/api-plan.md`
   - `qa/changes/<change-id>/plans/api-test-data-plan.md`
   - `qa/changes/<change-id>/plans/api-codegen-plan.md`
   - `qa/changes/<change-id>/plans/m3-review-summary.md`
   - `qa/changes/<change-id>/plans/data-knowledge.proposal.yaml`（仅当 `.aws/data-knowledge.yaml` 缺失时）
2. Update `workflow-state.yaml`:
   - Set `phases.api_plan.status = done`
   - List **all actually generated** output files under `phases.api_plan.outputs`（含 `data-knowledge.proposal.yaml`，若已生成）
   - **Do NOT** set `phases.api_plan_review.status` — that gate belongs to `aws-api-plan-reviewer`

---

# API Planning for QA

名称：API 测试计划生成

描述："QA 超能力：在生成 API 测试代码之前必须使用。根据 case.yaml、proposal.md 和数据知识库生成可 Review 的 api-plan.md、api-test-data-plan.md、api-codegen-plan.md 和 m3-review-summary.md。此 Skill 不生成测试代码，不执行 pytest。"

将 QA Case Delta 转化为可审查的 API 测试实现计划。

此 Skill 是 AWS M3 的 Stage 1。它读取 `qa/changes/<change-id>/cases/**/case.yaml`，筛选 API 自动化 Case，生成 API 测试计划、测试数据计划和代码生成计划。完成后进入 `aws-api-plan-reviewer`；只有 `api-plan-review.json` 满足 gate 条件后，orchestrator 才可进入 `aws-api-codegen`。

## When to Use

当用户要求：

- 生成 M3 API plan
- 根据 case 生成 api-plan
- 生成 api-test-data-plan
- 生成 api-codegen-plan
- 为 API 自动化测试做计划

使用此 Skill。

## Do Not Use When

以下情况不得使用此 Skill：

- 用户已经要求根据 plan 生成测试代码
- 用户要求执行 pytest
- 用户要求生成 `/tests/api/*.py`
- 用户要求生成 execution result
- 需求还没有生成 case.yaml
- `case-review.json` 中 `decision != "pass"`（结构化 gate 未放行）

## Inputs

**Required**（缺失则 STOP）：

- `qa/changes/<change-id>/.qa.yaml`
- `qa/changes/<change-id>/proposal.md`
- `qa/changes/<change-id>/cases/**/case.yaml`

**Optional**（缺失则 warning，不 STOP）：

- `.aws/config.yaml`
- `.aws/data-knowledge.yaml`
- Backend source files（用于确认 endpoint / schema）

如果 `.aws/config.yaml` 不存在，记录 warning，但不要阻断。

如果 `.aws/data-knowledge.yaml` 不存在，**不阻断 plan 阶段**。不得直接写入项目级知识库。必须生成 proposal：

`qa/changes/<change-id>/plans/data-knowledge.proposal.yaml`

并在 `m3-review-summary.md` 中记录 warning，分别给出 **Plan Readiness** 与 **Codegen Readiness**（见判定规则）。

> **Plan vs Codegen gate（data-knowledge）：**
> - **aws-api-plan**：`.aws/data-knowledge.yaml` 缺失不阻断 planning；生成 `plans/data-knowledge.proposal.yaml`；Plan Readiness 可为 `ready_with_warnings`；**Codegen Readiness 必须为 `not_ready`**。
> - **aws-api-codegen**：`.aws/data-knowledge.yaml` 缺失是 **BLOCKER**；`data-knowledge.proposal.yaml` 仅供参考，不可替代正式知识库。
> - **Reason**：`aws-api-codegen` 无论 selected case 是否有最小 data 需求，启动前均要求正式 `.aws/data-knowledge.yaml` 存在。

## Outputs

只能生成：

- `qa/changes/<change-id>/plans/api-plan.md`
- `qa/changes/<change-id>/plans/api-test-data-plan.md`
- `qa/changes/<change-id>/plans/api-codegen-plan.md`
- `qa/changes/<change-id>/plans/m3-review-summary.md`
- `qa/changes/<change-id>/plans/data-knowledge.proposal.yaml`（仅当 `.aws/data-knowledge.yaml` 不存在时）

不得生成：

- `.aws/data-knowledge.yaml`（只写 proposal，不写项目级知识库）
- `/tests/api/*.py`
- `/tests/fixtures/*.py`
- `/tests/helpers/*.py`
- `qa/changes/<change-id>/execution/*`

## Workflow

1. 读取 `.aws/config.yaml`，如果不存在则记录 warning。
2. 读取 `qa/changes/<change-id>/.qa.yaml`。
3. 读取 `qa/changes/<change-id>/proposal.md`。
4. 定位 `qa/changes/<change-id>/cases/**/case.yaml`。
5. 解析 `schema_version`、`added`、`modified`、`removed`。
6. **只从 `added` 和 `modified` 中**筛选 `type = API` 且 `automation.required = true` 的 Case。如果没有符合条件的 Case，停止并报告。
   - **不得**为 `removed` 下的 case 生成 API plan。
   - `removed` 条目（仅含 `case_id` / `reason`）只用于上下文与 archive merge 校验，不参与 plan 筛选。
7. 读取 `.aws/data-knowledge.yaml`。如果不存在，生成 `plans/data-knowledge.proposal.yaml`（不得写入 `.aws/data-knowledge.yaml`），并在 `m3-review-summary.md` 中记录 warning。
8. 生成 `plans/api-plan.md`（如果 `plans/` 目录不存在则创建）。
9. 生成 `plans/api-test-data-plan.md`。
10. 生成 `plans/api-codegen-plan.md`。
11. 生成 `plans/m3-review-summary.md`。
12. 停止，不生成测试代码。
13. 提醒下一步为 `aws-api-plan-reviewer`；orchestrator 进入 `aws-api-codegen` 须同时满足：
    - `api-plan-review.json` `decision == "pass"`
    - `codegen_readiness in ["ready", "ready_with_warnings"]`
    - `.aws/data-knowledge.yaml` 存在
    用户口头确认不能替代 gate。

## Checklist

必须按顺序完成：

- [ ] 找到 change-id
- [ ] 读取 `.qa.yaml`
- [ ] 读取 `proposal.md`
- [ ] 读取 `cases/**/case.yaml`
- [ ] 确认 `schema_version: "1.0"`
- [ ] 只从 `added` / `modified` 筛选 API 自动化 Case（`type: API` + `automation.required: true`）；跳过 `removed`
- [ ] 读取 `.aws/data-knowledge.yaml`（不存在则写 `plans/data-knowledge.proposal.yaml`，不得直接写 `.aws/data-knowledge.yaml`）
- [ ] 生成 `api-plan.md`
- [ ] 生成 `api-test-data-plan.md`
- [ ] 生成 `api-codegen-plan.md`
- [ ] 生成 `m3-review-summary.md`
- [ ] 确认未生成测试代码
- [ ] 更新 `workflow-state.yaml`（`phases.api_plan.status = done`）
- [ ] 输出下一步提示（指向 `aws-api-plan-reviewer`，而非直接 `aws-api-codegen`）

## Output Contract

### api-plan.md

路径：`qa/changes/<change-id>/plans/api-plan.md`

必须包含：

- **Source** — case 来源文件路径
- **Scope** — Case ID 和标题列表（仅来自 `added` + `modified`；不含 `removed`）
- **API Targets** — 表格：Case ID \| Scenario \| Method \| Path \| Expected
- **Auth Strategy** — 每个 Case 的认证需求
- **Request Strategy** — headers、body、params（method / path / headers 只写入 plan，**不得**写回 `case.yaml`）
- **Assertion Strategy** — 每个 Case 的断言列表
- **Mock Strategy** — 需要 mock 的依赖（或 None）
- **Cleanup Strategy** — 测试后状态清理
- **Output File Candidates** — 建议测试文件路径
- **Needs Review** — 无法自行确认、需要人工确认的项
- **Blockers** — 阻塞 codegen 的项（或 None）

**API Targets TBD 规则**（Method 或 Path 无法确认时）：

- 表格中 Method / Path 列使用 `TBD`，并在同一行或 **Needs Review** 中说明原因。
- 不得静默猜测 endpoint 或 HTTP method。
- 若仅缺非关键细节（如可选 query param），写入 **Needs Review**；Plan Readiness 可为 `ready_with_warnings`。
- 若 Method 或 Path 完全未知且无法从 backend source 推断，写入 **Blockers**；Plan Readiness 与 Codegen Readiness 均必须为 `not_ready`。
- 若 Method 已知但 Path 不确定（或反之），至少写入 **Needs Review**；若阻塞 codegen 映射，同时写入 **Blockers**。

### api-test-data-plan.md

路径：`qa/changes/<change-id>/plans/api-test-data-plan.md`

必须包含：

- **Scope** — 需要数据准备的 Case 列表
- **Required Data** — 表格：Entity \| State \| Capability
- **Preconditions** — 来自 `case.yaml:preconditions`
- **Capability Mapping** — 表格：Need \| Capability \| Source \| Status（found/missing/warning）
- **Setup Strategy** — 有序的数据准备步骤
- **Runtime Verify Strategy** — API 调用前的数据验证断言
- **Cleanup Strategy** — 测试后清理
- **No Data Required Cases** — 不需要数据准备的 Case
- **Blockers / Assumptions** — 未解决的数据依赖
- **Review Checklist** — 需要 reviewer 确认的项

### api-codegen-plan.md

路径：`qa/changes/<change-id>/plans/api-codegen-plan.md`

此文件只描述如何生成测试代码，不直接包含测试代码。

必须包含：

- **Target Files** — 表格：File \| Purpose
- **Test Function Mapping** — 表格：Case ID \| Test Function \| Target File
- **Fixture Mapping** — 表格：Fixture \| Source \| Required By
- **Helper Mapping** — 共享 helper 说明
- **Import Strategy** — 每个文件需要的 import 模块
- **Assertion Mapping** — 表格：Case ID \| Assertions
- **Data Setup Mapping** — 每个 Case 的数据准备步骤
- **Cleanup Mapping** — 每个 Case 的清理步骤
- **Run Guidance** — 供 `aws-run`（Phase 8）参考的运行指引（如 pytest 参数、标记、环境变量）；此字段不由 aws-api-codegen 执行，仅作为执行层的输入
- **Codegen Preconditions** — codegen 开始前必须满足的条件：
  - `api-plan-review.json` `decision == "pass"`
  - `codegen_readiness in ["ready", "ready_with_warnings"]`（来自 reviewer，非 plan 自评）
  - **正式** `.aws/data-knowledge.yaml` **必须存在**（硬 gate；`data-knowledge.proposal.yaml` 不可替代；plan 阶段缺失时 Codegen Readiness 必须为 `not_ready`，须先补齐知识库）

### m3-review-summary.md

路径：`qa/changes/<change-id>/plans/m3-review-summary.md`

必须包含：

- **Change** — change-id
- **Loaded Case Files** — 已处理的 case.yaml 路径列表
- **API Cases** — 总数（仅 `added` + `modified`）、plan 就绪数、codegen 就绪状态
- **Removed Cases** — `removed` 中的 case_id 列表（仅记录，不纳入 plan）
- **Generated Plan Files** — 必填四个 plan 文件路径；若生成了 `data-knowledge.proposal.yaml`，单独列出为 optional artifact
- **Data Knowledge Layer Status** — OK / Warning 及 capability 解析结果
- **Blockers** — 阻塞 codegen 的项（或 None）
- **Needs Review** — 需要人工确认的项
- **Plan Readiness** — `ready` / `ready_with_warnings` / `not_ready`（plan 文档是否完整、可 review）
- **Codegen Readiness** — `ready` / `ready_with_warnings` / `not_ready`（review pass 后 orchestrator 是否可进入 `aws-api-codegen`）
- **Next Step** — 指引 reviewer 运行 `aws-api-plan-reviewer`；codegen 需等 `api-plan-review.json` gate 通过

### Plan Readiness 判定

评估 plan 文档本身是否完整、可 review（**不**等同于可 codegen）：

| 值 | 条件 |
|----|------|
| `ready` | 无 Blockers；Needs Review 为空或均为非阻塞项；所有 selected API cases 已映射 |
| `ready_with_warnings` | 无 Blockers；存在非阻塞 Needs Review；或 capability `confidence: low` 但未阻塞 endpoint 映射 |
| `not_ready` | 存在 Blockers；或 API Target Method/Path 为 `TBD` 且无法映射 |

### Codegen Readiness 判定

评估 review pass 后 orchestrator 是否可进入 `aws-api-codegen`（**严于** Plan Readiness）：

| 值 | 条件 |
|----|------|
| `ready` | Plan Readiness = `ready`；`.aws/data-knowledge.yaml` 存在且 selected cases 所需 capability 解析 OK |
| `ready_with_warnings` | Plan Readiness = `ready` 或 `ready_with_warnings`；`.aws/data-knowledge.yaml` **存在**；存在非阻塞 Needs Review；所需 capability 已确认或 safely optional |
| `not_ready` | Plan Readiness = `not_ready`；**或** `.aws/data-knowledge.yaml` 缺失（**无论** selected cases 是否有 data / auth / cleanup 需求）；**或** 缺失 data capability 且无法 propose 合理候选 |

**`.aws/data-knowledge.yaml` 缺失时的分层（硬规则）：**

- Plan 阶段不阻断 → 可生成 `data-knowledge.proposal.yaml`；**Plan Readiness** 可为 `ready_with_warnings`。
- **Codegen Readiness 必须为 `not_ready`** — 无论 selected API cases 是否有最小 data 需求。
- **Reason**：`aws-api-codegen` 启动前均要求正式 `.aws/data-knowledge.yaml` 存在；`data-knowledge.proposal.yaml` 仅为 remediation artifact。
- Orchestrator 须在 `.aws/data-knowledge.yaml` 补齐并 re-review 后，才可进入 codegen。

## Data Knowledge Layer Rules

必须尝试读取：`.aws/data-knowledge.yaml`（缺失时不阻断 plan 阶段）。

**Stage gate（plan vs codegen）：**

| Stage | `.aws/data-knowledge.yaml` 缺失时 |
|-------|-----------------------------------|
| **aws-api-plan** | 不阻断 planning；生成 `plans/data-knowledge.proposal.yaml`；Plan Readiness 可为 `ready_with_warnings`；**Codegen Readiness 必须为 `not_ready`** |
| **aws-api-codegen** | **BLOCKER**；`data-knowledge.proposal.yaml` 仅供参考，不可替代正式知识库 |

如果文件不存在：

1. 生成 `plans/data-knowledge.proposal.yaml` — 使用以下**空提案模板**。
2. **不得**生成 `.aws/data-knowledge.yaml`。
3. **不得**在模板中发明具体能力名称（fixture 名、auth 方式、cleanup 方法）。
4. 若 `tests/` 目录存在，扫描并将发现的候选能力填入 `discovered_candidates`（置 `confidence: low`）。
5. 若 `tests/` 目录不存在或不可读，**不得**伪造候选能力；在 `m3-review-summary.md` 记录 warning，并将相关项写入 `needs_review`。
6. 将缺失能力记录在 `needs_review`。

```yaml
capabilities:
  fixtures: {}
  auth: {}
  cleanup: {}

discovered_candidates:
  - name: <candidate-fixture-or-factory-name>
    source: <file-path-where-found>
    confidence: low | medium | high

needs_review:
  - <missing capability description>
```

规则：

- 不得自由发明 fixture、factory、auth、cleanup。
- `discovered_candidates` 仅记录候选，不等于已确认的能力。
- 如果 capability 缺失或 `confidence: low`，必须记录为 blocker 或 needs_review，并据此更新 **Plan Readiness** 与 **Codegen Readiness**（见判定规则）。
- 如果 `.aws/data-knowledge.yaml` 缺失，**Codegen Readiness 必须为 `not_ready`**（与 case 是否有 data 需求无关）。
- 如果 capability 存在但 verify 不完整，必须记录为 needs_review。
- Stage 1 只做静态校验，不执行真实造数。
- `data-knowledge.proposal.yaml` 不得被 codegen 当作 `.aws/data-knowledge.yaml` 的替代品。

## Hard Rules

- Always generate plans before codegen.
- This Skill must not generate test code.
- This Skill must not generate execution results.
- Always read `qa/changes/<change-id>/cases/**/case.yaml`.
- Only process API cases under `added` and `modified`.
- Do NOT generate API plans for cases under `removed`. `removed` entries are read only for context and archive merge validation.
- Only process API cases with `automation.required = true`.
- Always generate api-plan.md.
- Always generate api-test-data-plan.md.
- Always generate api-codegen-plan.md.
- Always generate m3-review-summary.md.
- Never silently guess endpoint paths.
- Never invent fixtures, factories, auth helpers, or cleanup helpers.
- Missing data capability must be recorded as blocker or needs_review.
- PRD is not read from a fixed directory; requirements come from case.yaml and proposal.md.
- Test code generation requires `api-plan-review.json` `decision == "pass"`. User approval may be input to `aws-api-plan-reviewer`, but is not itself a gate artifact.
- Never write method, path, or headers back to `case.yaml`.
- Do not set `phases.api_plan_review.status` — that belongs to `aws-api-plan-reviewer`.

## Stop Conditions

必须在生成以下四个必填 plan 文件后立即停止：

- `api-plan.md`
- `api-test-data-plan.md`
- `api-codegen-plan.md`
- `m3-review-summary.md`

若 `.aws/data-knowledge.yaml` 缺失，还必须生成 `data-knowledge.proposal.yaml`（第五个 optional artifact）。

停止前必须先更新 `workflow-state.yaml`：

- 设置 `phases.api_plan.status = done`
- 在 `phases.api_plan.outputs` 下列出**所有实际生成**的输出文件路径（含 `data-knowledge.proposal.yaml`，若已生成）
- **不得**设置 `phases.api_plan_review.status`

停止后必须输出：

```
M3 Stage 1 completed. Next: aws-api-plan-reviewer.
Orchestrator may invoke aws-api-codegen only if:
- api-plan-review.json has decision == "pass"
- codegen_readiness in ["ready", "ready_with_warnings"]
- .aws/data-knowledge.yaml exists
User verbal approval cannot substitute api-plan-review.json.
```

不得继续生成：

- `/tests/api/*.py`
- `/tests/fixtures/*.py`
- `/tests/helpers/*.py`
- `qa/changes/<change-id>/execution/*`

## Anti-patterns

禁止：

- "这个 Case 很简单，直接生成测试代码"
- 未生成 plan 就生成 `/tests/api`
- 自动猜测 endpoint 并不标记 review
- 自由发明 fixture 或 auth helper
- 在 plan 阶段执行 pytest
- 在 plan 阶段写 execution result
- 将 method/path/header 写回 case.yaml

## Next Workflow

完成后，下一个工作流是：

**aws-api-plan-reviewer**

流程：
1. 将 plan 文件交由 `aws-api-plan-reviewer` 生成 `api-plan-review.json`。
2. orchestrator 进入 `aws-api-codegen` 须**同时**满足：
   - `decision == "pass"`
   - `codegen_readiness in ["ready", "ready_with_warnings"]`
   - `.aws/data-knowledge.yaml` 存在
3. 若 plan 阶段 `.aws/data-knowledge.yaml` 缺失，`m3-review-summary.md` 中 **Codegen Readiness 必须为 `not_ready`**；须先补齐正式知识库并 re-review，不可仅凭 `ready_with_warnings` 跳转 codegen。

用户的自然语言确认（"看起来不错"、"继续"）**不能替代** `api-plan-review.json` gate；用户 approval 可作为 `aws-api-plan-reviewer` 的输入，但不是 gate artifact 本身。
