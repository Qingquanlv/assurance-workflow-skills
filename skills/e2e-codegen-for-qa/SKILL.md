---
name: e2e-codegen-for-qa
description: Use only after E2E plan files have been reviewed and the user explicitly requests codegen. Triggers on: "generate E2E test code from plan", "continue E2E codegen", "implement e2e-codegen-plan", "generate /tests/e2e". Reads Stage 1 plan files and generates Playwright tests, fixtures, script-based data setup, and execution results. Never runs before planning is complete.
---

# E2E Codegen for QA

名称：E2E 测试代码生成

描述："QA 超能力：仅在 E2E plan 已 Review 后使用。根据 e2e-plan.md、e2e-test-data-plan.md 和 e2e-codegen-plan.md 生成 Playwright 测试、fixtures、脚本化前置数据，并执行 Playwright 生成执行结果。此 Skill 不生成新的 Case，不重新设计测试范围。"

将已 Review 的 E2E 测试计划转化为可执行 Playwright 测试代码。

此 Skill 是 AWE M4 的 Stage 2。它必须读取 Stage 1 生成的 plan 文件，并基于这些文件生成 `/tests/e2e`、`/tests/fixtures`、脚本化前置数据和 execution 结果。

## When to Use

当用户明确要求：

- 根据 E2E plan 生成测试代码
- 继续 E2E codegen
- 实现 e2e-codegen-plan.md
- 根据 M4 plan 生成 `/tests/e2e`
- 执行本次 E2E 测试

使用此 Skill。

## Do Not Use When

以下情况不得使用此 Skill：

- `e2e-plan.md` 尚未生成
- `e2e-test-data-plan.md` 尚未生成
- `e2e-codegen-plan.md` 尚未生成
- `m4-review-summary.md` 尚未生成
- 用户还没有确认继续 codegen
- 用户要求重新设计测试范围
- 用户要求生成 API-only 测试代码
- E2E plan 仍有 blocker

## Inputs

必须读取：

- `qa/changes/<change-id>/plans/e2e-plan.md`
- `qa/changes/<change-id>/plans/e2e-test-data-plan.md`
- `qa/changes/<change-id>/plans/e2e-codegen-plan.md`
- `qa/changes/<change-id>/plans/m4-review-summary.md`
- `qa/changes/<change-id>/cases/**/case.yaml`
- `.awe/data-knowledge.yaml`

如果缺少任何 plan 文件，必须停止，并提示先运行 `e2e-planning-for-qa`。

## Outputs

可以生成：

- `/tests/e2e/*.spec.ts`
- `/tests/fixtures/*.ts`
- `qa/changes/<change-id>/scripts/e2e-data-setup.*`
- `qa/changes/<change-id>/execution/e2e-result.json`
- `qa/changes/<change-id>/execution/e2e-summary.md`
- `qa/changes/<change-id>/execution/traces/*`

不得生成：

- `/tests/helpers/*`
- `/tests/e2e/pages/*`
- POM / Page Object Model

不得生成或修改：

- `proposal.md`
- `case.yaml`
- `e2e-plan.md`
- `e2e-test-data-plan.md`
- `e2e-codegen-plan.md`

除非用户明确要求修订 plan。

## Workflow

1. 读取 `e2e-plan.md`。
2. 读取 `e2e-test-data-plan.md`。
3. 读取 `e2e-codegen-plan.md`。
4. 读取 `m4-review-summary.md`。
5. 读取 `case.yaml`。
6. 读取 `.awe/data-knowledge.yaml`。
7. 检查 Codegen Preconditions（见 Output Contract 中的 Codegen Preconditions）。
8. 如果 `m4-review-summary.md` 中 Codegen Readiness 不是 `approved` 或 `ready`，必须请求用户明确确认后才能继续。
9. 校验 route、natural steps、selector strategy、assertion、fixture、auth、cleanup、data setup script 映射完整性。
10. 根据 `e2e-test-data-plan.md` 生成 `qa/changes/<change-id>/scripts/e2e-data-setup.*`。
11. 根据 `e2e-codegen-plan.md` 按需生成 `/tests/fixtures/*.ts`。
12. 根据 `e2e-codegen-plan.md` 生成 `/tests/e2e/*.spec.ts`。
13. 尝试执行 Playwright。如果无法执行，标记 skipped 并说明原因。
14. 生成 `execution/e2e-result.json`。
15. 生成 `execution/e2e-summary.md`。
16. 如果 Playwright 产生 trace / screenshot / video，归档到 `execution/traces/`。
17. 输出 E2E Codegen Review Summary。

## Checklist

必须按顺序完成：

- [ ] 确认用户要求继续 E2E codegen
- [ ] 读取 `e2e-plan.md`
- [ ] 读取 `e2e-test-data-plan.md`
- [ ] 读取 `e2e-codegen-plan.md`
- [ ] 读取 `m4-review-summary.md`
- [ ] 读取 `case.yaml`
- [ ] 读取 `.awe/data-knowledge.yaml`
- [ ] 检查 Codegen Preconditions
- [ ] 校验 route 和 natural steps
- [ ] 校验数据 setup script capability
- [ ] 校验 selector strategy
- [ ] 生成 `qa/changes/<change-id>/scripts/e2e-data-setup.*`
- [ ] 按需生成 `/tests/fixtures/*.ts`
- [ ] 生成 `/tests/e2e/*.spec.ts`
- [ ] 执行或尝试执行 Playwright
- [ ] 生成 `e2e-result.json`
- [ ] 生成 `e2e-summary.md`
- [ ] 输出 E2E Codegen Review Summary

## Output Contract

### /tests/e2e/*.spec.ts

必须满足：

- 使用 Playwright Test。
- 每个 test 必须包含 Case ID（写入 test title 或 annotation）。
- 每个断言必须来自 `case.yaml` 或 `e2e-codegen-plan.md`，不得凭空添加。
- 默认不生成 POM。
- 默认不生成 `/tests/e2e/pages/*`。
- 不得硬编码生产账号、密码、Token。
- 不得使用固定 sleep 作为默认等待策略；必须使用 Playwright 条件等待（`waitFor*`、`expect(locator).toBeVisible()`）。
- locator 选择优先级：role > label > text > testid > CSS fallback。
- API setup / script setup 必须在 UI 操作前完成。
- 前置数据 verify 失败时，不得继续 UI 步骤，必须 fail fast。
- E2E 只覆盖用户路径，不把造数流程扩展成 UI 点击流程。

### /tests/fixtures/*.ts

必须满足：

- 仅当 `e2e-test-data-plan.md` 需要 Playwright fixture 或 storageState 时才生成。
- fixture 来源必须映射到 `.awe/data-knowledge.yaml`。
- fixture 可封装登录态、storageState、测试环境 baseURL、测试数据读取。
- fixture 不得改变断言语义。
- fixture 不得隐藏业务失败。
- fixture 不得硬编码真实账号、密码、Token。
- 如果现有 fixture 已满足需求，优先复用，不要重复生成。

### qa/changes/\<change-id\>/scripts/e2e-data-setup.*

必须满足：

- 用于构造 E2E 前置业务数据。
- 优先通过 API / backend factory / seed 脚本构造数据。
- 不得通过 UI 点击构造复杂业务数据，除非 plan 已明确批准。
- 必须可重复执行。
- 必须从环境变量或测试配置读取 baseURL、账号、密码、token。
- 必须输出 E2E test 需要的实体 ID、URL、状态或 storageState。
- 必须包含 runtime verify。
- 必须包含 cleanup 或 cleanup reference。
- 不得使用生产环境地址、生产账号或真实 Token。

### execution/e2e-result.json

路径：`qa/changes/<change-id>/execution/e2e-result.json`

必须包含：

```json
{
  "status": "passed | failed | skipped",
  "total": 0,
  "passed": 0,
  "failed": 0,
  "skipped": 0,
  "cases": [
    {
      "case_id": "TC-ORDER-RECEIVE-001",
      "status": "passed | failed | skipped",
      "file": "tests/e2e/order-receive.spec.ts",
      "trace": "qa/changes/<change-id>/execution/traces/TC-ORDER-RECEIVE-001.zip",
      "message": ""
    }
  ]
}
```

不得伪造 passed。如果 Playwright 未执行，`status` 必须为 `skipped`。

### execution/e2e-summary.md

路径：`qa/changes/<change-id>/execution/e2e-summary.md`

必须包含：

- **Change ID**
- **Test Files** — 生成的 spec 文件列表
- **Data Setup Script** — 脚本路径及执行状态
- **Execution Command** — 运行命令
- **Result** — passed / failed / skipped 汇总
- **Failed Cases** — 失败 Case 的 case_id + 错误信息
- **Skipped Reason** — 如未执行则说明原因
- **Trace / Screenshot / Video** — 归档路径
- **Next Step** — 给 reviewer 的行动指引

### Codegen Preconditions

进入 codegen 前必须满足全部条件：

- `e2e-plan.md` 已存在且 Blockers 为空
- `e2e-test-data-plan.md` 已存在
- `e2e-codegen-plan.md` 已存在
- `m4-review-summary.md` Codegen Readiness = `ready` 或 `approved`
- `.awe/data-knowledge.yaml` 已存在，且所有 required capability 状态为 found
- Route Mapping 无 needs_review 项
- Selector Strategy 无 needs_review 项
- Data Setup Script Plan 无 needs_review 项

如果任何条件未满足，必须停止并请求用户确认。

## Data Setup Strategy

E2E 前置数据必须优先通过脚本构造。

推荐实现顺序：

1. `qa/changes/<change-id>/scripts/e2e-data-setup.*`
2. API setup call
3. backend factory / seed script
4. Playwright request fixture
5. shared fixture
6. UI setup（仅作为最后 fallback，必须写入 flaky risk）

脚本生成规则：

- 如果 plan 指定 data setup script，则必须生成脚本。
- 如果项目已有 data setup script，优先复用。
- 如果缺少 setup capability，停止 codegen，不得继续。
- 如果脚本无法运行，E2E 执行必须 skipped，不得继续 UI 步骤。
- 如果 verify 失败，E2E 执行必须 failed 或 skipped，并写明原因。
- cleanup 必须在脚本或 fixture 中明确。

## Execution Rules

可以执行：

```bash
npx playwright test tests/e2e/<target-file>.spec.ts
```

或按项目现有脚本执行（pnpm / yarn / npm）。

如果项目暂时没有可运行前端、baseURL、浏览器依赖或测试账号，必须：

- 生成测试代码。
- 生成 `e2e-summary.md`。
- 标记 execution status = `skipped`。
- 写明 skipped reason。
- 不得伪造 `passed`。

## Hard Rules

- This Skill must only run after E2E planning is complete.
- Do not generate or modify Case YAML.
- Do not generate or modify `proposal.md`.
- Do not redesign test scope.
- Do not change assertions unless the plan explicitly says so.
- Do not generate API-only tests.
- Do not generate POM.
- Do not generate `/tests/e2e/pages/*`.
- Do not generate `/tests/helpers/*`.
- Do not hardcode real credentials, tokens, secrets, or environment-specific URLs.
- Do not invent setup scripts, fixtures, auth helpers, or cleanup helpers.
- Do not bypass `e2e-codegen-plan.md`.
- Do not fake Playwright success.
- If Playwright cannot run, mark execution as skipped with reason.
- If data setup cannot run, do not continue UI steps.

## Stop Conditions

必须停止并询问用户：

- 缺少 `e2e-plan.md`
- 缺少 `e2e-test-data-plan.md`
- 缺少 `e2e-codegen-plan.md`
- 缺少 `m4-review-summary.md`
- 缺少 `.awe/data-knowledge.yaml`
- Codegen Preconditions 未满足
- Data setup capability 缺失
- Route path 仍处于 needs_review
- Selector strategy 仍处于 needs_review
- Data setup script plan 仍处于 needs_review
- 用户未确认继续 codegen

## Anti-patterns

禁止：

- "Plan 文件不完整，但我先生成 Playwright"
- "我帮你补一个 setup script 名"
- "先用 UI 点一遍把数据造出来"
- "先写固定 sleep 等页面"
- "Playwright 没跑，但标记 passed"
- "顺手修改 case.yaml"
- "顺手补充断言"
- "把 E2E 测试扩展成 API 测试"
- "生成 Page Object Model"

## Next Workflow

完成后，下一个工作流是：

**execution-review-for-qa** 或后续 QA Review Skill。

如果测试失败，只能生成失败摘要，不得自动修改断言或自动合并修复。
