---
name: aws-e2e-codegen
description: Use only after E2E plan files have been reviewed and the user explicitly requests codegen. Triggers on: "generate E2E test code from plan", "continue E2E codegen", "implement e2e-codegen-plan", "generate /tests/e2e". Reads Stage 1 plan files and generates Python Playwright tests (test_*.py + conftest.py) and script-based data setup. Does NOT execute tests — execution is handled by aws-run. Never runs before planning is complete.
---

# E2E Codegen for QA

名称：E2E 测试代码生成

描述："QA 超能力：仅在 E2E plan 已 Review 后使用。根据 e2e-plan.md、e2e-test-data-plan.md 和 e2e-codegen-plan.md 生成 Python Playwright 测试（test_*.py + conftest.py）、脚本化前置数据，并执行 pytest --headed 生成执行结果。此 Skill 不生成新的 Case，不重新设计测试范围。"

**E2E Framework: Python Playwright。文件命名 `test_<module>.py` + `conftest.py`。执行命令 `uv run pytest tests/e2e/ -v --headed`。不使用 TypeScript Playwright（`*.spec.ts` + `npx playwright test`）。**

将已 Review 的 E2E 测试计划转化为可执行 Python Playwright 测试代码。

此 Skill 是 AWE M4 的 Stage 2。它必须读取 Stage 1 生成的 plan 文件，并基于这些文件生成 `/tests/e2e/test_*.py`、`/tests/e2e/conftest.py`、脚本化前置数据和 execution 结果。

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
- `.aws/data-knowledge.yaml`

如果缺少任何 plan 文件，必须停止，并提示先运行 `aws-e2e-plan`。

## Outputs

可以生成：

- `/tests/e2e/test_<module>.py`  ← Python Playwright 测试文件
- `/tests/e2e/conftest.py`
- `/tests/fixtures/**/*.py`（仅当 plan 中定义了 pytest fixture 时）
- `qa/changes/<change-id>/scripts/e2e-data-setup.py`

不生成 execution 结果文件 — 测试执行由 `aws-run` (Phase 8) 负责。

不得生成：

- `/tests/e2e/*.spec.ts`（不使用 TypeScript Playwright）
- `/tests/fixtures/*.ts`
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
6. 读取 `.aws/data-knowledge.yaml`。
7. 检查 Codegen Preconditions（见 Output Contract 中的 Codegen Preconditions）。
8. 检查 Codegen Readiness：
   - 优先读取 `qa/changes/<change-id>/review/plan-review.json`：如果 `decision == "pass"` 且 `codegen_readiness` 在 `["ready", "ready_with_warnings"]`，直接继续。
   - 如果 `plan-review.json` 不存在，则读取 `m4-review-summary.md`：如果 Codegen Readiness 不是 `ready` 或 `approved`，必须请求用户明确确认后才能继续。
   - 如果 `plan-review.json` 存在但 `codegen_readiness == "not_ready"`，必须停止，不得继续。
9. 校验 route、natural steps、selector strategy、assertion、fixture、auth、cleanup、data setup script 映射完整性。
10. 根据 `e2e-test-data-plan.md` 生成 `qa/changes/<change-id>/scripts/e2e-data-setup.py`。
11. 根据 `e2e-codegen-plan.md` 按需生成 `/tests/fixtures/**/*.py`（pytest fixtures）。
12. 根据 `e2e-codegen-plan.md` 生成 `/tests/e2e/test_<module>.py`。
13. 更新或生成 `/tests/e2e/conftest.py`（仅追加，不覆盖已有内容）。
14. **不执行 pytest** — 测试执行由 `aws-run` 负责（Phase 8）。
15. 输出 E2E Codegen Summary：已生成的文件列表及下一步提示。

## Checklist

Maintain a visible checklist for each item, or use the available task/todo tool if the environment supports it:

- [ ] 确认用户要求继续 E2E codegen
- [ ] 读取 `e2e-plan.md`
- [ ] 读取 `e2e-test-data-plan.md`
- [ ] 读取 `e2e-codegen-plan.md`
- [ ] 读取 `m4-review-summary.md`
- [ ] 读取 `case.yaml`
- [ ] 读取 `.aws/data-knowledge.yaml`
- [ ] 检查 Codegen Preconditions
- [ ] 校验 route 和 natural steps
- [ ] 校验数据 setup script capability
- [ ] 校验 selector strategy
- [ ] 生成 `qa/changes/<change-id>/scripts/e2e-data-setup.py`
- [ ] 按需生成 `/tests/fixtures/**/*.py`
- [ ] 生成 `/tests/e2e/test_<module>.py`
- [ ] 更新 `/tests/e2e/conftest.py`
- [ ] 输出 E2E Codegen Summary（文件列表 + 下一步）

## Output Contract

### /tests/e2e/test_\<module\>.py

必须满足：

- 使用 Python Playwright（`playwright` + `pytest-playwright`）。
- 每个测试函数必须包含 Case ID（写入 docstring 或注释）。
- 每个断言必须来自 `case.yaml` 或 `e2e-codegen-plan.md`，不得凭空添加。
- 默认不生成 POM。
- 默认不生成 `/tests/e2e/pages/*`。
- 不得硬编码生产账号、密码、Token。
- 不得使用固定 `time.sleep()` 作为默认等待策略；必须使用 Playwright 条件等待（`expect(locator).to_be_visible()`、`page.wait_for_*`）。
- locator 选择优先级：role > label > text > testid > CSS fallback。
- API setup / script setup 必须在 UI 操作前完成。
- 前置数据 verify 失败时，不得继续 UI 步骤，必须 fail fast。
- E2E 只覆盖用户路径，不把造数流程扩展成 UI 点击流程。

### /tests/e2e/conftest.py

必须满足：

- 仅追加新 fixture，不覆盖已有 fixture。
- 可封装 `browser_context`、`page`、`base_url`、登录 storageState、测试数据读取。
- fixture 来源必须映射到 `.aws/data-knowledge.yaml`。
- fixture 不得改变断言语义。
- fixture 不得隐藏业务失败。
- fixture 不得硬编码真实账号、密码、Token。

### /tests/fixtures/\*\*/\*.py

必须满足：

- 仅当 `e2e-test-data-plan.md` 需要 pytest fixture 时才生成。
- fixture 来源必须映射到 `.aws/data-knowledge.yaml`。
- 如果现有 fixture 已满足需求，优先复用，不要重复生成。

### qa/changes/\<change-id\>/scripts/e2e-data-setup.py

必须满足：

- 用于构造 E2E 前置业务数据。
- 优先通过 API / backend factory / seed 脚本构造数据。
- 不得通过 UI 点击构造复杂业务数据，除非 plan 已明确批准。
- 必须可重复执行。
- 必须从环境变量或测试配置读取 baseURL、账号、密码、token。
- 必须输出 E2E test 需要的实体 ID、URL、状态。
- 必须包含 runtime verify。
- 必须包含 cleanup 或 cleanup reference。
- 不得使用生产环境地址、生产账号或真实 Token。

### Codegen Output Summary

codegen 完成后输出以下内容（不执行测试）：

- 已生成的文件列表（`tests/e2e/test_*.py`, `conftest.py`, `scripts/e2e-data-setup.py`）
- 任何已知的 TODO 或需要人工确认的条目
- 提示下一步：运行 `aws-run` 执行测试（Phase 8）

### Codegen Preconditions

进入 codegen 前必须满足全部条件：

- `e2e-plan.md` 已存在且 Blockers 为空
- `e2e-test-data-plan.md` 已存在
- `e2e-codegen-plan.md` 已存在
- `plan-review.json` 存在且 `decision == "pass"` 且 `codegen_readiness` 为 `ready` 或 `ready_with_warnings`（如无 review JSON，则 `m4-review-summary.md` Codegen Readiness = `ready` 或 `approved`）
- `.aws/data-knowledge.yaml` 已存在，且所有 required capability 状态为 found
- Route Mapping 无 needs_review 项
- Selector Strategy 无 needs_review 项
- Data Setup Script Plan 无 needs_review 项

如果任何条件未满足，必须停止并请求用户确认。

## Data Setup Strategy

E2E 前置数据必须优先通过脚本构造。

推荐实现顺序：

1. `qa/changes/<change-id>/scripts/e2e-data-setup.py`
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
- cleanup 必须在脚本或 conftest.py 中明确。

## Execution

此 Skill 不执行测试。测试执行由 `aws-run` 负责（Phase 8）。

参考执行命令（由 aws-run 调用）：`uv run pytest tests/e2e/ -v --headed`

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
- Do not generate `*.spec.ts` files (TypeScript Playwright is not used in this project).
- Do not hardcode real credentials, tokens, secrets, or environment-specific URLs.
- Do not invent setup scripts, fixtures, auth helpers, or cleanup helpers.
- Do not bypass `e2e-codegen-plan.md`.
- Do not fake pytest success.
- If pytest cannot run, mark execution as skipped with reason.
- If data setup cannot run, do not continue UI steps.

## Stop Conditions

必须停止并询问用户：

- 缺少 `e2e-plan.md`
- 缺少 `e2e-test-data-plan.md`
- 缺少 `e2e-codegen-plan.md`
- 缺少 `m4-review-summary.md`
- 缺少 `.aws/data-knowledge.yaml`
- Codegen Preconditions 未满足
- Data setup capability 缺失
- Route path 仍处于 needs_review
- Selector strategy 仍处于 needs_review
- Data setup script plan 仍处于 needs_review
- 用户未确认继续 codegen

## Anti-patterns

禁止：

- "Plan 文件不完整，但我先生成测试"
- "我帮你补一个 setup script 名"
- "先用 UI 点一遍把数据造出来"
- "先写固定 time.sleep() 等页面"
- "pytest 没跑，但标记 passed"
- "顺手修改 case.yaml"
- "顺手补充断言"
- "把 E2E 测试扩展成 API 测试"
- "生成 Page Object Model"
- "生成 *.spec.ts 文件"

## Next Workflow

完成后，下一个工作流是：

**aws-inspect** 或后续 QA Review Skill。

如果测试失败，只能生成失败摘要，不得自动修改断言或自动合并修复。
