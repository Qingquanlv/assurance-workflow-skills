---
name: aws-api-codegen
description: Use only after API plan files have been reviewed and the user explicitly requests codegen. Triggers on: "generate test code from plan", "continue API codegen", "implement api-codegen-plan", "generate /tests/api". Reads Stage 1 plan files and generates pytest code, fixtures, and helpers. Does NOT execute pytest — test execution is Phase 8 aws-run. Never runs before planning is complete.
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.api_plan_review.status == pass` (gate must be cleared).
3. Read input files from disk: `plans/api-plan.md`, `plans/api-test-data-plan.md`, `plans/api-codegen-plan.md`, `review/api-plan-review.json`.
4. Verify `review/api-plan-review.json` exists and `decision == "pass"`. If not, stop.
5. Use files as the sole source of truth.

**After completing work:**

1. Write generated test files:
   - `tests/api/test_<module>_api.py`
   - `tests/api/helpers/<module>_api.py`
   - `tests/api/conftest.py` (append only, do not overwrite existing)
2. Update `workflow-state.yaml`:
   - Set `phases.api_codegen.status = done`
   - List generated files under `phases.api_codegen.generated_tests.files`

---

# API Codegen for QA

名称：API 测试代码生成

描述："QA 超能力：仅在 API plan 已 Review 后使用。根据 api-plan.md、api-test-data-plan.md 和 api-codegen-plan.md 生成 pytest 测试代码、fixtures、helpers。**不执行 pytest，不生成执行结果** — 测试执行由 aws-run（Phase 8）负责。此 Skill 不生成新的 Case，不重新设计测试范围。"

将已 Review 的 API 测试计划转化为可执行 pytest 测试代码。

此 Skill 是 AWS M3 的 Stage 2。它必须读取 Stage 1 生成的 plan 文件，并基于这些文件生成 `/tests/api`、`/tests/fixtures`、`/tests/helpers`。**不执行 pytest，不产生 execution 结果** — 执行由 Phase 8 `aws-run` 负责。

## When to Use

当用户明确要求：

- 根据 plan 生成测试代码
- 继续 API codegen
- 实现 api-codegen-plan.md
- 根据 M3 plan 生成 `/tests/api`

使用此 Skill。

**不适用于：执行测试（使用 aws-run）、查看执行结果（使用 aws-inspect）。**

## Do Not Use When

以下情况不得使用此 Skill：

- api-plan.md 尚未生成
- api-test-data-plan.md 尚未生成
- api-codegen-plan.md 尚未生成
- m3-review-summary.md 尚未生成
- 用户还没有确认继续 codegen
- 用户要求重新设计测试范围
- 用户要求生成 E2E 测试代码

## Inputs

必须读取：

- `qa/changes/<change-id>/plans/api-plan.md`
- `qa/changes/<change-id>/plans/api-test-data-plan.md`
- `qa/changes/<change-id>/plans/api-codegen-plan.md`
- `qa/changes/<change-id>/plans/m3-review-summary.md`
- `qa/changes/<change-id>/cases/**/case.yaml`
- `.aws/data-knowledge.yaml`

如果缺少任何 plan 文件，必须停止，并提示先运行 `aws-api-plan`。

## Mandatory Review JSON Gate

在生成任何 API 测试代码之前，必须验证 API plan review gate：

- `qa/changes/<change-id>/review/api-plan-review.json` 必须存在
- 必须是合法 JSON
- `decision == "pass"`
- `codegen_readiness in ["ready", "ready_with_warnings"]`

如果以上任一条件不满足（文件缺失、非法 JSON、`decision != pass`、或 `codegen_readiness == "not_ready"`），必须 **STOP**，不得生成代码。

用户在对话中说 "approved" / "looks good" 不能替代此 JSON gate。如果用户口头批准，必须由 `aws-api-plan-reviewer` 写出 `api-plan-review.json` 后才能继续。

## Outputs

可以生成：

- `/tests/api/*.py`
- `/tests/fixtures/*.py`
- `/tests/helpers/*.py`

**不执行 pytest，不生成 execution 结果文件** — 测试执行完全由 `aws-run`（Phase 8）负责。此 skill 完成后，直接运行 `aws-run` 执行测试。

不得生成或修改：

- `proposal.md`
- `case.yaml`
- `api-plan.md`
- `api-test-data-plan.md`
- `api-codegen-plan.md`

除非用户明确要求修订 plan。

## Workflow

1. 读取 `api-plan.md`。
2. 读取 `api-test-data-plan.md`。
3. 读取 `api-codegen-plan.md`。
4. 读取 `m3-review-summary.md`。
5. 读取 `case.yaml`。
6. 读取 `.aws/data-knowledge.yaml`。
7. 检查 Codegen Preconditions：所有 plan 文件存在且无缺失。
8. 检查 Mandatory Review JSON Gate（见上文章节）：
   - 读取 `qa/changes/<change-id>/review/api-plan-review.json`。
   - 如果文件缺失、非法 JSON、`decision != "pass"`，或 `codegen_readiness == "not_ready"` → **STOP**，不得生成代码。
   - 仅当 `decision == "pass"` 且 `codegen_readiness in ["ready", "ready_with_warnings"]` 时才继续。
9. 校验 endpoint、assertion、fixture、auth、cleanup 映射完整性。
10. 根据 `api-codegen-plan.md` 生成 `/tests/api/*.py`。
11. 根据 `api-test-data-plan.md` 生成 `/tests/fixtures/*.py`。
12. 根据 `api-codegen-plan.md` 生成 `/tests/helpers/*.py`（如 helper 计划非空）。
13. **不执行 pytest** — 测试执行由 `aws-run` 负责（Phase 8）。
14. 输出 Codegen Summary：已生成的文件列表及下一步提示。

## Checklist

必须按顺序完成：

- [ ] 确认用户要求继续 codegen
- [ ] 读取 `api-plan.md`
- [ ] 读取 `api-test-data-plan.md`
- [ ] 读取 `api-codegen-plan.md`
- [ ] 读取 `m3-review-summary.md`
- [ ] 读取 `case.yaml`
- [ ] 读取 `.aws/data-knowledge.yaml`
- [ ] 检查 Codegen Preconditions
- [ ] 检查 Mandatory Review JSON Gate（`api-plan-review.json` 存在、合法、`decision == pass`、`codegen_readiness in [ready, ready_with_warnings]`）
- [ ] 校验测试数据 capability
- [ ] 生成 `/tests/api/*.py`
- [ ] 生成 `/tests/fixtures/*.py`
- [ ] 生成 `/tests/helpers/*.py`
- [ ] 输出 Codegen Summary（文件列表 + 下一步）

## Output Contract

### /tests/api/*.py

必须满足：

- 使用 pytest。
- 每个测试函数必须包含 Case ID（作为注释或 docstring）。
- 每个断言必须来自 `case.yaml` 或 `api-codegen-plan.md`，不得自行扩展。
- 不得硬编码生产账号、密码、Token。
- 有效 Token 必须来自 fixture 或 `.aws/data-knowledge.yaml` 中的 auth capability。
- 无 Token Case 必须显式不传 Authorization header。
- 无效 Token Case 可使用本地固定无效字符串（如 `invalid-token`）。
- 不得生成 E2E 代码。
- 不得生成 POM（Page Object Model）。

### /tests/fixtures/*.py

必须满足：

- fixture 来源必须映射到 `.aws/data-knowledge.yaml`。
- 不得自由发明业务状态。
- 不得硬编码真实账号、密码、Token。
- 必须保留 cleanup 入口或说明 cleanup 由现有 fixture 负责。

### /tests/helpers/*.py

必须满足：

- helper 只封装重复 API 调用或客户端初始化。
- helper 不得改变断言语义。
- helper 不得隐藏业务失败。

### Codegen Output Summary

codegen 完成后输出以下内容（不执行测试）：

- 已生成的文件列表（`tests/api/*.py`, `tests/fixtures/*.py`, `tests/helpers/*.py`）
- 任何已知的 TODO 或需要人工确认的条目
- 提示下一步：运行 `aws-run` 执行测试（Phase 8）

## Hard Rules

- This Skill must only run after API planning.
- Do not generate or modify Case YAML.
- Do not generate or modify `proposal.md`.
- Do not redesign scope.
- Do not change assertions unless the plan explicitly says so.
- Do not generate E2E tests.
- Do not generate POM.
- Do not hardcode real credentials, tokens, secrets, or environment-specific URLs.
- Do not invent fixtures, factories, auth helpers, or cleanup helpers.
- Do not bypass `api-codegen-plan.md`.
- Do not execute pytest. Test execution belongs to aws-run (Phase 8).
- Do not write any execution result files (api-result.json, summary.md, etc.).

## Workaround Policy

Do not silently change tests to avoid product bugs.

If a direct API endpoint fails due to a product bug and tests use an alternate endpoint for verification, the codegen skill must:

1. Add an explicit test docstring note explaining the workaround.
2. Add a local comment in the test function body explaining why the alternate endpoint is used.
3. Write or append a known product issue record to:

```text
qa/changes/<change-id>/execution/known-product-issues.md
```

4. Mark the direct endpoint as a coverage gap.
5. Ensure execution status is `passed_with_known_issues`, not `passed`.
6. Never claim the original endpoint is directly covered if it is not exercised successfully.

### known-product-issues.md Template

```markdown
# Known Product Issues

## KPI-001 — <short description>

- Category: known_product_issue
- Severity: major | minor | critical
- Module: <module-name>
- Endpoint: `<METHOD /api/v1/path>`
- Affected cases:
  - `<case-id>`
- Symptom:
  - <What happens when the endpoint is called>
- Root cause:
  - <Why it happens, if known>
- Workaround:
  - Tests verify <what> through `<alternate endpoint>`.
- Coverage gap:
  - Direct `<endpoint>` coverage remains open.
- Status: open
- Required fix:
  - <What must be done to resolve>
```

### Example

```
GET /api/v1/menu/get returns 500 because it returns a raw ORM object through
Success(data=result) without serialization. Tests verify detail/update through
GET /api/v1/menu/list as a temporary workaround. Direct GET /api/v1/menu/get
endpoint coverage remains open.
```

If the product bug should block release, do not workaround silently. Stop and report a blocker instead.

## Stop Conditions

必须停止并询问用户：

- 缺少 `api-plan.md`
- 缺少 `api-test-data-plan.md`
- 缺少 `api-codegen-plan.md`
- 缺少 `m3-review-summary.md`
- 缺少 `.aws/data-knowledge.yaml`
- `api-plan-review.json` 缺失、非法 JSON、`decision != pass`、或 `codegen_readiness == not_ready`
- Codegen Preconditions 未满足
- Data capability 缺失
- Endpoint path 仍处于 needs_review
- 用户未确认继续 codegen
- A workaround would hide a product bug without writing `known-product-issues.md`

## Anti-patterns

禁止：

- "Plan 文件不完整，但我先生成代码"
- "我帮你补一个 fixture 名"
- "先生成一个差不多能跑的测试"
- "pytest 没跑，但标记 passed"
- "顺手修改 case.yaml"
- "顺手补充断言"
- "把 API 测试扩展成 E2E"

## Next Workflow

完成后，下一步是：

**Phase 8 — 运行 `aws-run`** 执行测试：

```bash
aws run --change <change-id>
```

如果测试失败，由 `aws-inspect` 分析原因，不得在此 skill 内自动修改断言或合并修复。
