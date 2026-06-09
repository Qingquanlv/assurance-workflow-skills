---
name: aws-api-plan
description: Use when a QA Case Delta contains API automation cases and you need to generate reviewable plan files before writing any test code. Triggers on: "generate API plan", "M3 Stage 1", "api-plan.md", "review before codegen", "api planning". Only processes API cases with automation.required = true. Never generates test code.
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.case_review.status == pass` (gate must be cleared).
3. Read input files from disk: `proposal.md`, `cases/<module>/case.yaml`, `.aws/config.yaml`, `.aws/data-knowledge.yaml` (if missing, proceed and generate proposal — see Data Knowledge Layer Rules), backend source files.
   > **Note:** `data-knowledge.proposal.yaml` is a planning artifact only. It is NOT a valid substitute for `.aws/data-knowledge.yaml` in `aws-api-codegen`.
4. If required files are missing, stop and report.
5. Use files as the sole source of truth.

**After completing work:**

1. Write output files:
   - `qa/changes/<change-id>/plans/api-plan.md`
   - `qa/changes/<change-id>/plans/api-test-data-plan.md`
   - `qa/changes/<change-id>/plans/api-codegen-plan.md`
   - `qa/changes/<change-id>/plans/m3-review-summary.md`
2. Update `workflow-state.yaml`:
   - Set `phases.api_plan.status = done`
   - List all output files under `phases.api_plan.outputs`

---

# API Planning for QA

名称：API 测试计划生成

描述："QA 超能力：在生成 API 测试代码之前必须使用。根据 case.yaml、proposal.md 和数据知识库生成可 Review 的 api-plan.md、api-test-data-plan.md、api-codegen-plan.md 和 m3-review-summary.md。此 Skill 不生成测试代码，不执行 pytest。"

将 QA Case Delta 转化为可审查的 API 测试实现计划。

此 Skill 是 AWS M3 的 Stage 1。它读取 `qa/changes/<change-id>/cases/**/case.yaml`，筛选 API 自动化 Case，生成 API 测试计划、测试数据计划和代码生成计划。用户 Review 通过后，才能进入 `aws-api-codegen`。

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

必须读取：

- `.aws/config.yaml`
- `.aws/data-knowledge.yaml`
- `qa/changes/<change-id>/.qa.yaml`
- `qa/changes/<change-id>/proposal.md`
- `qa/changes/<change-id>/cases/**/case.yaml`

如果 `.aws/config.yaml` 不存在，记录 warning，但不要阻断。

如果 `.aws/data-knowledge.yaml` 不存在，**不得直接写入 `.aws/data-knowledge.yaml`**。必须生成 proposal：

`qa/changes/<change-id>/plans/data-knowledge.proposal.yaml`

并在 `m3-review-summary.md` 中记录 warning。

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
6. 筛选 `type = API` 且 `automation.required = true` 的 Case。如果没有，停止并报告。
7. 读取 `.aws/data-knowledge.yaml`。如果不存在，生成 `plans/data-knowledge.proposal.yaml`（不得写入 `.aws/data-knowledge.yaml`），并在 `m3-review-summary.md` 中记录 warning。
8. 生成 `plans/api-plan.md`（如果 `plans/` 目录不存在则创建）。
9. 生成 `plans/api-test-data-plan.md`。
10. 生成 `plans/api-codegen-plan.md`。
11. 生成 `plans/m3-review-summary.md`。
12. 停止，不生成测试代码。
13. 提醒用户 Review 后再继续 `aws-api-codegen`。

## Checklist

必须按顺序完成：

- [ ] 找到 change-id
- [ ] 读取 `.qa.yaml`
- [ ] 读取 `proposal.md`
- [ ] 读取 `cases/**/case.yaml`
- [ ] 确认 `schema_version: "1.0"`
- [ ] 筛选 API 自动化 Case（`type: API` + `automation.required: true`）
- [ ] 读取 `.aws/data-knowledge.yaml`（不存在则写 `plans/data-knowledge.proposal.yaml`，不得直接写 `.aws/data-knowledge.yaml`）
- [ ] 生成 `api-plan.md`
- [ ] 生成 `api-test-data-plan.md`
- [ ] 生成 `api-codegen-plan.md`
- [ ] 生成 `m3-review-summary.md`
- [ ] 确认未生成测试代码
- [ ] 更新 `workflow-state.yaml`（`phases.api_plan.status = done`）
- [ ] 输出下一步提示

## Output Contract

### api-plan.md

路径：`qa/changes/<change-id>/plans/api-plan.md`

必须包含：

- **Source** — case 来源文件路径
- **Scope** — Case ID 和标题列表
- **API Targets** — 表格：Case ID \| Scenario \| Method \| Path \| Expected
- **Auth Strategy** — 每个 Case 的认证需求
- **Request Strategy** — headers、body、params
- **Assertion Strategy** — 每个 Case 的断言列表
- **Mock Strategy** — 需要 mock 的依赖（或 None）
- **Cleanup Strategy** — 测试后状态清理
- **Output File Candidates** — 建议测试文件路径
- **Needs Review** — 无法自行确认、需要人工确认的项
- **Blockers** — 阻塞 codegen 的项（或 None）

endpoint 路径无法确认时：必须写入 **Needs Review**，不得静默猜测。

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
- **Codegen Preconditions** — codegen 开始前必须满足的条件

### m3-review-summary.md

路径：`qa/changes/<change-id>/plans/m3-review-summary.md`

必须包含：

- **Change** — change-id
- **Loaded Case Files** — 已处理的 case.yaml 路径列表
- **API Cases** — 总数、plan 就绪数、codegen 就绪状态
- **Generated Plan Files** — 四个文件的路径
- **Data Knowledge Layer Status** — OK / Warning 及 capability 解析结果
- **Blockers** — 阻塞 codegen 的项（或 None）
- **Needs Review** — 需要人工确认的项
- **Codegen Readiness** — `ready` / `ready_with_warnings` / `not_ready`
- **Next Step** — 给 reviewer 的行动指引

## Data Knowledge Layer Rules

必须读取：`.aws/data-knowledge.yaml`

如果文件不存在：

1. 生成 `plans/data-knowledge.proposal.yaml` — 使用以下**空提案模板**。
2. **不得**生成 `.aws/data-knowledge.yaml`。
3. **不得**在模板中发明具体能力名称（fixture 名、auth 方式、cleanup 方法）。
4. 扫描 `tests/` 目录，将发现的候选能力填入 `discovered_candidates`（置 `confidence: low`）。
5. 将缺失能力记录在 `needs_review`。

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
- 如果 capability 缺失或 `confidence: low`，必须记录为 blocker 或 needs_review，并将 Codegen Readiness 设为 `ready_with_warnings` 或 `not_ready`。
- 如果 capability 存在但 verify 不完整，必须记录为 needs_review。
- Stage 1 只做静态校验，不执行真实造数。

## Hard Rules

- Always generate plans before codegen.
- This Skill must not generate test code.
- This Skill must not generate execution results.
- Always read `qa/changes/<change-id>/cases/**/case.yaml`.
- Only process API cases with `automation.required = true`.
- Always generate api-plan.md.
- Always generate api-test-data-plan.md.
- Always generate api-codegen-plan.md.
- Always generate m3-review-summary.md.
- Never silently guess endpoint paths.
- Never invent fixtures, factories, auth helpers, or cleanup helpers.
- Missing data capability must be recorded as blocker or needs_review.
- PRD is not read from a fixed directory; requirements come from case.yaml and proposal.md.
- Test code generation requires a separate user confirmation.

## Stop Conditions

必须在生成以下四个文件后立即停止：

- `api-plan.md`
- `api-test-data-plan.md`
- `api-codegen-plan.md`
- `m3-review-summary.md`

停止前必须：

1. 更新 `qa/changes/<change-id>/workflow-state.yaml`：
   - `phases.api_plan.status = done`
   - `phases.api_plan.outputs` 列出四个生成文件路径

然后输出：

```
M3 Stage 1 completed. Please review the generated plan files before continuing to API Codegen.
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
2. 只有当 `api-plan-review.json` 满足以下条件，orchestrator 才可以进入 `aws-api-codegen`：
   - `decision == "pass"`
   - `codegen_readiness in ["ready", "ready_with_warnings"]`

用户的自然语言确认（"看起来不错"、"继续"）**不能替代** `api-plan-review.json` gate。
