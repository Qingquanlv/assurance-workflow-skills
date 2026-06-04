---
name: api-planning-for-qa
description: Use when a QA Case Delta contains API automation cases and you need to generate reviewable plan files before writing any test code. Triggers on: "generate API plan", "M3 Stage 1", "api-plan.md", "review before codegen", "api planning". Only processes API cases with automation.required = true. Never generates test code.
---

# API Planning for QA

名称：API 测试计划生成

描述："QA 超能力：在生成 API 测试代码之前必须使用。根据 case.yaml、proposal.md 和数据知识库生成可 Review 的 api-plan.md、test-data-plan.md、api-codegen-plan.md 和 m3-review-summary.md。此 Skill 不生成测试代码，不执行 pytest。"

将 QA Case Delta 转化为可审查的 API 测试实现计划。

此 Skill 是 AWE M3 的 Stage 1。它读取 `qa/changes/<change-id>/cases/**/case.yaml`，筛选 API 自动化 Case，生成 API 测试计划、测试数据计划和代码生成计划。用户 Review 通过后，才能进入 `api-codegen-for-qa`。

## When to Use

当用户要求：

- 生成 M3 API plan
- 根据 case 生成 api-plan
- 生成 test-data-plan
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
- case.yaml 尚未通过人工 Review

## Inputs

必须读取：

- `.awe/config.yaml`
- `.awe/data-knowledge.yaml`
- `qa/changes/<change-id>/.qa.yaml`
- `qa/changes/<change-id>/proposal.md`
- `qa/changes/<change-id>/cases/**/case.yaml`

如果 `.awe/config.yaml` 不存在，记录 warning，但不要阻断。

如果 `.awe/data-knowledge.yaml` 不存在，可以生成模板，但必须在 `m3-review-summary.md` 中记录 warning。

## Outputs

只能生成：

- `qa/changes/<change-id>/plans/api-plan.md`
- `qa/changes/<change-id>/plans/test-data-plan.md`
- `qa/changes/<change-id>/plans/api-codegen-plan.md`
- `qa/changes/<change-id>/plans/m3-review-summary.md`

不得生成：

- `/tests/api/*.py`
- `/tests/fixtures/*.py`
- `/tests/helpers/*.py`
- `qa/changes/<change-id>/execution/*`

## Workflow

1. 读取 `.awe/config.yaml`，如果不存在则记录 warning。
2. 读取 `qa/changes/<change-id>/.qa.yaml`。
3. 读取 `qa/changes/<change-id>/proposal.md`。
4. 定位 `qa/changes/<change-id>/cases/**/case.yaml`。
5. 解析 `schema_version`、`added`、`modified`、`removed`。
6. 筛选 `type = API` 且 `automation.required = true` 的 Case。如果没有，停止并报告。
7. 读取 `.awe/data-knowledge.yaml`。如果不存在，生成最小模板并标记 warning。
8. 生成 `plans/api-plan.md`（如果 `plans/` 目录不存在则创建）。
9. 生成 `plans/test-data-plan.md`。
10. 生成 `plans/api-codegen-plan.md`。
11. 生成 `plans/m3-review-summary.md`。
12. 停止，不生成测试代码。
13. 提醒用户 Review 后再继续 `api-codegen-for-qa`。

## Checklist

必须按顺序完成：

- [ ] 找到 change-id
- [ ] 读取 `.qa.yaml`
- [ ] 读取 `proposal.md`
- [ ] 读取 `cases/**/case.yaml`
- [ ] 确认 `schema_version: "1.0"`
- [ ] 筛选 API 自动化 Case（`type: API` + `automation.required: true`）
- [ ] 读取或创建 `.awe/data-knowledge.yaml`
- [ ] 生成 `api-plan.md`
- [ ] 生成 `test-data-plan.md`
- [ ] 生成 `api-codegen-plan.md`
- [ ] 生成 `m3-review-summary.md`
- [ ] 确认未生成测试代码
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

### test-data-plan.md

路径：`qa/changes/<change-id>/plans/test-data-plan.md`

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
- **Execution Plan** — 如何运行测试及写入结果
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
- **Codegen Readiness** — `ready` / `pending_review` / `blocked`
- **Next Step** — 给 reviewer 的行动指引

## Data Knowledge Layer Rules

必须读取：`.awe/data-knowledge.yaml`

如果文件不存在，生成最小模板并继续：

```yaml
capabilities:
  fixtures:
    active_user_fixture:
      kind: pytest_fixture
      symbol: tests.fixtures.auth_fixtures.active_user_fixture
      entity: user
      state: active
      returns:
        persisted: true
        id_attr: id
        auth_subject: user
      verify:
        operation: get_user_by_id
        asserts:
          - expr: "$.status"
            equals: active

  auth:
    bearer_default:
      acquire:
        operation: login
      extract_jsonpath: "$.access_token"
      header_template: "Authorization: Bearer {token}"

  cleanup:
    user_session_logout:
      operation: logout
      retry_safe: true
```

规则：

- 不得自由发明 fixture、factory、auth、cleanup。
- 如果 capability 缺失，必须记录为 blocker 或 needs_review。
- 如果 capability 存在但 verify 不完整，必须记录为 needs_review。
- Stage 1 只做静态校验，不执行真实造数。

## Hard Rules

- Always generate plans before codegen.
- This Skill must not generate test code.
- This Skill must not generate execution results.
- Always read `qa/changes/<change-id>/cases/**/case.yaml`.
- Only process API cases with `automation.required = true`.
- Always generate api-plan.md.
- Always generate test-data-plan.md.
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
- `test-data-plan.md`
- `api-codegen-plan.md`
- `m3-review-summary.md`

停止后必须输出：

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

**api-codegen-for-qa**

只有用户 Review plan 并明确要求继续 codegen 后，才能进入下一步。
