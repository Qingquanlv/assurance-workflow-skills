---
name: awe-e2e-plan
description: Use when a QA Case Delta contains E2E automation cases and you need to generate reviewable E2E plan files before writing any Playwright code. Triggers on: "generate E2E plan", "M4 Stage 1", "e2e-plan.md", "review before E2E codegen", "E2E planning". Only processes E2E cases with automation.required = true. Never generates test code.
---

# E2E Planning for QA

名称：E2E 测试计划生成

描述："QA 超能力：在生成 Playwright E2E 测试代码之前必须使用。根据 case.yaml、proposal.md 和数据知识库生成可 Review 的 e2e-plan.md、e2e-test-data-plan.md、e2e-codegen-plan.md 和 m4-review-summary.md。此 Skill 不生成测试代码，不执行 Playwright。"

将 QA Case Delta 转化为可审查的 E2E 测试实现计划。

此 Skill 是 AWE M4 的 Stage 1。它读取 `qa/changes/<change-id>/cases/**/case.yaml`，筛选 E2E 自动化 Case，生成 E2E 测试计划、前置数据计划和代码生成计划。用户 Review 通过后，才能进入 `awe-e2e-codegen`。

## When to Use

当用户要求：

- 生成 M4 E2E plan
- 根据 case 生成 e2e-plan
- 生成 e2e-test-data-plan
- 生成 e2e-codegen-plan
- 为 Playwright 自动化测试做计划

使用此 Skill。

## Do Not Use When

以下情况不得使用此 Skill：

- 用户已经要求根据 plan 生成 Playwright 测试代码
- 用户要求执行 Playwright
- 用户要求生成 `/tests/e2e/*.spec.ts`
- 用户要求生成 execution result
- 需求还没有生成 case.yaml
- case.yaml 尚未通过人工 Review
- 用户要做 API-only 测试计划

## Inputs

必须读取：

- `.awe/config.yaml`
- `.awe/data-knowledge.yaml`
- `qa/changes/<change-id>/.qa.yaml`
- `qa/changes/<change-id>/proposal.md`
- `qa/changes/<change-id>/cases/**/case.yaml`

如果 `.awe/config.yaml` 不存在，记录 warning，但不要阻断。

如果 `.awe/data-knowledge.yaml` 不存在，不得直接写入项目级知识库。必须生成 proposal：

`qa/changes/<change-id>/plans/data-knowledge.proposal.yaml`

并在 `m4-review-summary.md` 中记录 warning 或 blocked。

## Outputs

只能生成：

- `qa/changes/<change-id>/plans/e2e-plan.md`
- `qa/changes/<change-id>/plans/e2e-test-data-plan.md`
- `qa/changes/<change-id>/plans/e2e-codegen-plan.md`
- `qa/changes/<change-id>/plans/m4-review-summary.md`
- `qa/changes/<change-id>/plans/data-knowledge.proposal.yaml`（仅当 data knowledge 缺失时）

不得生成：

- `/tests/e2e/*.spec.ts`
- `/tests/fixtures/*.ts`
- `/tests/helpers/*`
- `/tests/e2e/pages/*`
- `qa/changes/<change-id>/scripts/*`
- `qa/changes/<change-id>/execution/*`

## Workflow

1. 读取 `.awe/config.yaml`，如果不存在则记录 warning。
2. 读取 `qa/changes/<change-id>/.qa.yaml`。
3. 读取 `qa/changes/<change-id>/proposal.md`。
4. 定位 `qa/changes/<change-id>/cases/**/case.yaml`。
5. 解析 `schema_version`、`added`、`modified`、`removed`。
6. 筛选 `type = E2E` 且 `automation.required = true` 的 Case。
7. 如果是 `type = Mixed`，只提取 E2E 目标并标记来源为 Mixed。
8. 检查 priority：默认只计划 P0 / P1 E2E，P2 / P3 必须进入 Needs Review。
9. 读取 `.awe/data-knowledge.yaml`。
10. 如果 `.awe/data-knowledge.yaml` 不存在，生成 `plans/data-knowledge.proposal.yaml`，不得写入 `.awe/data-knowledge.yaml`。
11. 如果没有任何 E2E case，停止并报告。
12. 生成 `plans/e2e-plan.md`（如果 `plans/` 目录不存在则创建）。
13. 生成 `plans/e2e-test-data-plan.md`。
14. 生成 `plans/e2e-codegen-plan.md`。
15. 生成 `plans/m4-review-summary.md`。
16. 停止，不生成测试代码。
17. 提醒用户 Review 后再继续 `awe-e2e-codegen`。

## Checklist

必须按顺序完成：

- [ ] 找到 change-id
- [ ] 读取 `.qa.yaml`
- [ ] 读取 `proposal.md`
- [ ] 读取 `cases/**/case.yaml`
- [ ] 确认 `schema_version: "1.0"`
- [ ] 筛选 E2E 自动化 Case（`type: E2E` + `automation.required: true`）
- [ ] 确认只默认处理 P0 / P1 E2E（P2 / P3 进入 Needs Review）
- [ ] 读取 `.awe/data-knowledge.yaml`
- [ ] 如果数据知识库缺失，生成 `data-knowledge.proposal.yaml`
- [ ] 生成 `e2e-plan.md`
- [ ] 生成 `e2e-test-data-plan.md`
- [ ] 生成 `e2e-codegen-plan.md`
- [ ] 生成 `m4-review-summary.md`
- [ ] 确认未生成 Playwright 测试代码
- [ ] 输出下一步提示

## Output Contract

### e2e-plan.md

路径：`qa/changes/<change-id>/plans/e2e-plan.md`

必须包含：

- **Source** — case 来源文件路径
- **Scope** — Case ID 和标题列表
- **User Journey** — 用户路径说明
- **Route Mapping** — 页面路径、入口页面、目标页面
- **Natural Steps** — 来自 `case.yaml:steps`
- **Assertion Strategy** — 每个 Case 的可观察 UI 断言
- **Selector Strategy** — role / label / text / testid / CSS fallback 的策略说明
- **Network / API Dependency** — 依赖的后端接口
- **Flaky Risk Notes** — 异步、动态数据、第三方依赖、加载状态
- **Output File Candidates** — 建议测试文件路径
- **Needs Review**
- **Blockers**

Selector Strategy 优先级（必须遵守）：

1. role
2. label
3. text
4. testid
5. CSS（只作为 fallback）

禁止：
- 将 locator 写入 case.yaml
- 默认生成 POM

### e2e-test-data-plan.md

路径：`qa/changes/<change-id>/plans/e2e-test-data-plan.md`

必须包含：

- **Scope** — 需要数据准备的 Case 列表
- **Required Data** — 表格：Entity \| State \| Capability
- **Preconditions** — 来自 `case.yaml:preconditions`
- **Data Setup Strategy** — 优先通过脚本或 API 构造；UI 造数只作为最后 fallback
- **Data Setup Script Plan** — 脚本路径、输入、输出、cleanup 规划
- **Capability Mapping** — 表格：Need \| Capability \| Source \| Status（found/missing/warning）
- **Runtime Verify Strategy** — UI 步骤前验证数据状态的断言
- **Login / Auth State Strategy** — storageState 或 per-test login 策略
- **Cleanup Strategy** — 测试后数据清理
- **No Data Required Cases** — 不需要数据准备的 Case
- **Blockers / Assumptions** — 未解决的数据依赖
- **Review Checklist**

### e2e-codegen-plan.md

路径：`qa/changes/<change-id>/plans/e2e-codegen-plan.md`

此文件只描述如何生成测试代码，不直接包含测试代码。

必须包含：

- **Target Files** — 表格：File \| Purpose
- **Test Function Mapping** — 表格：Case ID \| Test Function \| Target File
- **Fixture Mapping** — 表格：Fixture \| Source \| Required By
- **Data Setup Script Mapping** — 表格：Script \| Input \| Output \| Required By
- **Import Strategy** — 每个文件的 import 模块
- **Step Mapping** — 来自 `case.yaml:steps` 的 Playwright 步骤映射
- **Locator Strategy** — 每个交互点的 locator 选择规则（role > label > text > testid > CSS）
- **Assertion Mapping** — 表格：Case ID \| Assertions
- **Cleanup Mapping** — 每个 Case 的清理步骤
- **Execution Plan** — 如何运行测试及写入结果
- **Codegen Preconditions** — codegen 开始前必须满足的条件

### m4-review-summary.md

路径：`qa/changes/<change-id>/plans/m4-review-summary.md`

必须包含：

- **Change** — change-id
- **Loaded Case Files** — 已处理的 case.yaml 路径列表
- **E2E Cases** — 总数、plan 就绪数、codegen 就绪状态
- **Generated Plan Files** — 四个文件的路径
- **Data Knowledge Layer Status** — OK / Warning / Blocked 及 capability 解析结果
- **Data Setup Script Status** — 脚本计划状态
- **Blockers** — 阻塞 codegen 的项（或 None）
- **Needs Review** — 需要人工确认的项
- **Codegen Readiness** — `ready` / `pending_review` / `blocked`
- **Next Step** — 给 reviewer 的行动指引

## Data Setup Strategy

E2E 前置数据优先通过脚本或 API 构造，不得默认通过 UI 造数。

优先级（必须按顺序评估）：

1. `qa/changes/<change-id>/scripts/e2e-data-setup.*`
2. API setup script
3. backend factory / seed script
4. Playwright request fixture
5. shared test fixture
6. UI setup（仅作为最后 fallback，必须写入 flaky risk）

规则：

- 前置业务数据必须尽量由脚本构造。
- 脚本必须可重复执行。
- 脚本不得使用生产账号、生产密码、真实 Token。
- 脚本必须从环境变量或测试配置读取 base URL 和凭证。
- 脚本必须输出后续 E2E 需要的实体 ID、URL、状态或 storage state。
- 脚本必须包含 cleanup 方案。
- 如果无法脚本化构造数据，必须记录 blocker 或 needs_review。
- UI 造数只能作为最后 fallback，且必须写入 flaky risk。

## Data Knowledge Layer Rules

必须读取：`.awe/data-knowledge.yaml`

最小建议结构：

```yaml
capabilities:
  setup_scripts:
    receivable_order_setup:
      kind: script
      symbol: qa/changes/<change-id>/scripts/e2e-data-setup.ts
      entity: order
      state: pending_receive
      returns:
        id_attr: order_id
        url_attr: order_url
      verify:
        operation: getOrderById
        asserts:
          - expr: "$.status"
            equals: pending_receive
      cleanup_ref: cleanup.order_delete

  auth:
    e2e_storage_state:
      kind: playwright_storage_state
      acquire:
        operation: login
      output: .auth/e2e-user.json

  cleanup:
    order_delete:
      operation: deleteOrderTestFactory
      retry_safe: true
```

规则：

- 不得自由发明 setup script、fixture、auth、cleanup。
- 如果 capability 缺失，必须记录为 blocker 或 needs_review。
- 如果 capability 存在但 verify 不完整，必须记录为 needs_review。
- Stage 1 只做静态校验，不执行真实造数。
- 不得将 data knowledge 模板直接写入 `.awe/data-knowledge.yaml`。

## Hard Rules

- Always generate E2E plans before codegen.
- This Skill must not generate Playwright test code.
- This Skill must not generate execution results.
- Always read `qa/changes/<change-id>/cases/**/case.yaml`.
- Only process E2E cases with `automation.required = true`.
- Only P0 / P1 E2E cases are planned by default; P2 / P3 enter Needs Review.
- Always generate e2e-plan.md.
- Always generate e2e-test-data-plan.md.
- Always generate e2e-codegen-plan.md.
- Always generate m4-review-summary.md.
- Never generate POM by default.
- Never write locators into case.yaml.
- Never use UI setup as first choice for test data.
- Prefer script-based setup for E2E preconditions.
- Never invent setup scripts, fixtures, auth helpers, or cleanup helpers.
- Missing data capability must be recorded as blocker or needs_review.
- Test code generation requires separate user confirmation.

## Stop Conditions

必须在生成以下四个文件后立即停止：

- `e2e-plan.md`
- `e2e-test-data-plan.md`
- `e2e-codegen-plan.md`
- `m4-review-summary.md`

停止后必须输出：

```
M4 Stage 1 completed. Please review the generated E2E plan files before continuing to E2E Codegen.
```

不得继续生成：

- `/tests/e2e/*.spec.ts`
- `/tests/fixtures/*.ts`
- `/tests/helpers/*`
- `/tests/e2e/pages/*`
- `qa/changes/<change-id>/scripts/*`
- `qa/changes/<change-id>/execution/*`

## Anti-patterns

禁止：

- "这个 E2E 很简单，直接生成 Playwright"
- 未生成 plan 就生成 `/tests/e2e`
- 默认通过 UI 点击来造复杂业务数据
- 自动猜测 route 并不标记 review
- 自由发明 setup script 或 auth helper
- 在 plan 阶段执行 Playwright
- 在 plan 阶段写 execution result
- 生成 POM
- 将 locator 写回 case.yaml

## Next Workflow

完成后，下一个工作流是：

**awe-e2e-codegen**

只有用户 Review plan 并明确要求继续 codegen 后，才能进入下一步。
