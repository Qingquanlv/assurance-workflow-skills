---
name: aws-api-codegen
description: Use only after api-plan-review.json has decision == "pass" and codegen_readiness in ["ready", "ready_with_warnings"]. Triggers on: "generate test code from plan", "continue API codegen", "implement api-codegen-plan", "generate /tests/api". User request may trigger this skill but never replaces the JSON gate. Reads Stage 1 plan files and generates pytest code, fixtures, and helpers. Does NOT execute pytest — test execution is Phase 8 aws-run. Never runs before planning is complete.
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.api_plan_review.status == pass` (gate must be cleared).
3. Read input files from disk: `plans/api-plan.md`, `plans/api-test-data-plan.md`, `plans/api-codegen-plan.md`, `plans/m3-review-summary.md`, `review/api-plan-review.json`, `.aws/data-knowledge.yaml`, `cases/**/case.yaml`.
4. Verify `review/api-plan-review.json` gate fields in order — **STOP** on first failure:
   - valid JSON
   - `review_type == "api-plan"`
   - `change_id == <change-id>`
   - `decision == "pass"`
   - `codegen_readiness in ["ready", "ready_with_warnings"]`
   - `blockers` is empty
   - no `needs_review` item has `blocking == true`
   - `.aws/data-knowledge.yaml` exists on disk
5. Use files as the sole source of truth.

**After completing work:**

1. Write generated test files per `api-codegen-plan.md` Target Files and **Generated File Policy**:
   - `tests/api/test_<module>_api.py` — required when mapped in plan
   - `tests/api/helpers/<module>_api.py` — only if helper mapping is non-empty
   - `tests/fixtures/<module>_fixtures.py` — only when plan + data-knowledge authorize new fixture wrappers
   - `tests/api/conftest.py` — only if plan explicitly requires it (see conftest rules)
   - `qa/changes/<change-id>/known-product-issues.md` — append implementation notes only when file already exists and reviewer acknowledged the issue (never first writer for coverage gaps)
   - `qa/changes/<change-id>/codegen/api-codegen-summary.md` (create `codegen/` directory if missing)
2. Update `workflow-state.yaml`:
   - Set `phases.api_codegen.status = done`
   - Set `phases.api_codegen.review_gate_file = review/api-plan-review.json`
   - Set `phases.api_codegen.codegen_readiness` = value from review JSON
   - List generated files under `phases.api_codegen.generated_tests.files`
   - Set `phases.api_codegen.warnings_carried` = warning IDs or summaries from review JSON
   - Set `phases.api_codegen.known_product_issues.present` = true|false
   - Set `phases.api_codegen.known_product_issues.file` = `qa/changes/<change-id>/known-product-issues.md` (if present)

Example `workflow-state.yaml` fragment:

```yaml
phases:
  api_codegen:
    status: done
    review_gate_file: review/api-plan-review.json
    codegen_readiness: ready_with_warnings
    generated_tests:
      files:
        - tests/api/test_<module>_api.py
    warnings_carried:
      - API-PLAN-FINDING-COV-001
    known_product_issues:
      present: true
      file: qa/changes/<change-id>/known-product-issues.md
```

---

# API Codegen for QA

名称：API 测试代码生成

描述："QA 超能力：仅在 API plan 已 Review 后使用。根据 api-plan.md、api-test-data-plan.md 和 api-codegen-plan.md 生成 pytest 测试代码、fixtures、helpers。**不执行 pytest，不生成执行结果** — 测试执行由 aws-run（Phase 8）负责。此 Skill 不生成新的 Case，不重新设计测试范围。"

将已 Review 的 API 测试计划转化为可执行 pytest 测试代码。

此 Skill 是 AWS M3 的 Stage 2。它必须读取 Stage 1 生成的 plan 文件，并基于这些文件生成 `tests/api/`、`tests/fixtures/`、`tests/api/helpers/`。**不执行 pytest，不产生 execution 结果** — 执行由 Phase 8 `aws-run` 负责。

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
- `.aws/data-knowledge.yaml`  ← **必须存在。缺失是 BLOCKER。**
- `qa/changes/<change-id>/review/api-plan-review.json`

Optional (required when `codegen_readiness == "ready_with_warnings"` due to endpoint coverage gap):

- `qa/changes/<change-id>/known-product-issues.md` — must exist before codegen if workaround / coverage gap is in scope

> **data-knowledge 分层规则：**
> - `aws-api-plan` 阶段：`.aws/data-knowledge.yaml` 缺失不阻断，生成 `data-knowledge.proposal.yaml`。
> - `aws-api-codegen` 阶段：`.aws/data-knowledge.yaml` **必须存在**。`data-knowledge.proposal.yaml` 仅供参考，不可替代。
> - 如果 `.aws/data-knowledge.yaml` 不存在，**STOP**——告知用户需先创建或 promote `data-knowledge.proposal.yaml`。

如果缺少任何 plan 文件，必须停止，并提示先运行 `aws-api-plan`。

## Mandatory Review JSON Gate

Same checks as Context Contract step 4. In summary:

- `qa/changes/<change-id>/review/api-plan-review.json` must exist and be valid JSON
- `review_type == "api-plan"` and `change_id == <change-id>`
- `decision == "pass"`
- `codegen_readiness in ["ready", "ready_with_warnings"]`
- `blockers` is empty
- no blocking `needs_review` items
- `.aws/data-knowledge.yaml` exists

If any condition fails, **STOP** — do not generate code.

用户在对话中说 "approved" / "looks good" 不能替代此 JSON gate。如果用户口头批准，必须由 `aws-api-plan-reviewer` 写出 `api-plan-review.json` 后才能继续。

### ready_with_warnings — Coverage Gap Hard Rules

If `codegen_readiness == "ready_with_warnings"` due to endpoint workaround / coverage gap:

- `qa/changes/<change-id>/known-product-issues.md` **MUST** already exist and document the gap (reviewer pass prerequisite)
- Codegen **MUST** include test docstring / comment referencing the known issue ID (e.g. `KPI-001`)
- Codegen **MUST NOT** claim direct endpoint coverage
- Codegen **MUST NOT** create a workaround if the warning is not already documented in `known-product-issues.md`
- Codegen **MUST NOT** be the first writer of `known-product-issues.md` for coverage gaps

For other non-blocking warnings (not coverage gaps):

- Carry warnings in test comments only when no guessing is required
- If any warning requires guessing endpoint, auth, fixture, schema, cleanup, or product behavior → **STOP**

## Outputs

可以生成（路径以项目根为基准；以 `api-codegen-plan.md` Target Files 为准）：

- `tests/api/test_<module>_api.py` — test functions (required when mapped)
- `tests/api/helpers/<module>_api.py` — **only if** helper mapping in plan is non-empty
- `tests/fixtures/<module>_fixtures.py` — **only if** plan + `.aws/data-knowledge.yaml` authorize new fixture wrappers
- `tests/api/conftest.py` — **only if** plan explicitly requires conftest changes (see below)
- `qa/changes/<change-id>/codegen/api-codegen-summary.md` — always

**known-product-issues.md:** Codegen may **append** implementation notes only when the file already exists and `aws-api-plan-reviewer` has acknowledged the issue. Codegen **MUST NOT** create the file for endpoint coverage gaps.

**不执行 pytest，不生成 execution 结果文件** — 测试执行完全由 `aws-run`（Phase 8）负责。此 skill 完成后，直接运行 `aws-run` 执行测试。

不得生成或修改：

- `proposal.md`
- `case.yaml`
- `api-plan.md`
- `api-test-data-plan.md`
- `api-codegen-plan.md`

除非用户明确要求修订 plan。

## Generated File Policy

- Only create or modify files listed in `api-codegen-plan.md` **Target Files**.
- If a target test file already exists, **append** new test functions only — do not overwrite unrelated tests.
- Do not delete existing tests.
- Preserve existing imports, fixtures, and project style.
- Do not generate empty helper or fixture files "just in case".

## conftest.py Policy

Update `tests/api/conftest.py` **only if** `api-codegen-plan.md` explicitly requires it.

- Prefer existing pytest fixture discovery (conftest hierarchy, `pytest_plugins`) over manual imports.
- If `tests/api/conftest.py` exists:
  - append only the minimal import or `pytest_plugins` entry required by the plan
  - never rewrite existing content
  - never duplicate existing imports
- If not required by the plan, do **not** create or modify `conftest.py`.

## Workflow

1. 读取 `api-plan.md`。
2. 读取 `api-test-data-plan.md`。
3. 读取 `api-codegen-plan.md`。
4. 读取 `m3-review-summary.md`。
5. 读取 `case.yaml`。
6. 读取 `.aws/data-knowledge.yaml`。
7. 检查 Codegen Preconditions：所有 plan 文件存在且无缺失。
8. 检查 Mandatory Review JSON Gate（Context Contract step 4 + **ready_with_warnings — Coverage Gap Hard Rules**）。
9. 校验 endpoint、assertion、fixture、auth、cleanup 映射完整性。
10. 根据 `api-codegen-plan.md` **Target Files** 生成或追加 `tests/api/test_<module>_api.py`。
11. 若 plan + `.aws/data-knowledge.yaml` 授权新 fixture wrapper，生成 `tests/fixtures/<module>_fixtures.py`；若 capability 已存在，复用现有 fixture，不新建文件。
12. 若 helper mapping 非空，生成 `tests/api/helpers/<module>_api.py`。
12b. 仅当 plan 明确要求时，按 **conftest.py Policy** 更新 `tests/api/conftest.py`。
13. **不执行 pytest** — 测试执行由 `aws-run` 负责（Phase 8）。
14. 创建 `qa/changes/<change-id>/codegen/`（若不存在），写入 `codegen/api-codegen-summary.md`。
15. 输出 Codegen Summary 摘要（文件列表 + 下一步提示）。

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
- [ ] 检查 Mandatory Review JSON Gate（完整 gate + coverage gap 规则）
- [ ] 校验测试数据 capability（复用已有 fixture 或仅在授权时新建）
- [ ] 生成或追加 `tests/api/test_<module>_api.py`
- [ ] 生成 `tests/fixtures/<module>_fixtures.py`（仅当 plan + data-knowledge 授权）
- [ ] 生成 `tests/api/helpers/<module>_api.py`（helper mapping 非空时）
- [ ] 更新 `tests/api/conftest.py`（仅 plan 明确要求时）
- [ ] 更新 `workflow-state.yaml`（`phases.api_codegen` 含 review_gate_file、codegen_readiness、warnings_carried、known_product_issues）
- [ ] 创建 `codegen/` 目录（若不存在），写入 `api-codegen-summary.md`
- [ ] 输出 Codegen Summary（文件列表 + 下一步）

## Output Contract

### tests/api/test_<module>_api.py

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

### tests/fixtures/<module>_fixtures.py

#### Test Data Strategy

**pytest `fixture` vs factory pattern — do not confuse them:**

- **pytest `fixture`** is the *injection mechanism* (the `@pytest.fixture` decorator). This is mandatory pytest convention. The `tests/fixtures/` directory name refers to this mechanism — do NOT rename or remove it.
- **factory pattern** refers to how data is generated *inside* a fixture: return a callable factory (dynamic data creation) rather than a static dict (hard-coded values).

Rules:
- When authorized to generate a new fixture, implement it as a factory: return a factory function or use `factory_boy` / `polyfactory` patterns rather than returning a plain static dict.
- Each test must receive an independent data instance — avoid shared mutable state between tests.
- Do not hard-code account IDs, tokens, or business-entity IDs in fixture bodies; derive them from `.aws/data-knowledge.yaml` capabilities.

#### ORM field length (dept / menu / role names)

When `.aws/data-knowledge.yaml` or `facts/fact-baseline.json` documents `CharField max_length` enforced at ORM/DB only (Pydantic may not validate):

- **Never** build test entity names longer than the ORM limit — overflow often surfaces as HTTP 500, not 422.
- **Dept.name** (`max_length=20`): use `tests/api/helpers/dept_api.py` → `unique_dept_name(prefix, hex_chars=8)` where `len(prefix) + 1 + 8 ≤ 20` (prefix ≤ 11 chars). Do **not** append long suffixes like `-updated` on update cases — generate a second `unique_dept_name()` instead.
- **Menu.name** (`max_length=20`): follow conftest comments (`qa-cat-` + hex ≤ 19 chars).
- Document **known product issues** (e.g. duplicate key → HTTP 500) in `known-product-issues.md` + `facts/fact-baseline.json` anomalies — separate from test-data length bugs.

```python
# Preferred: factory-as-fixture (each test gets independent data)
# NOTE: Adapt `entity_factory`, `/api/entities`, and field names
#       to the actual module per data-knowledge.yaml and the plan.
@pytest.fixture
def entity_factory(api_client):
    created = []
    def _create(**overrides):
        payload = {"name": "Test Entity", **overrides}
        r = api_client.post("/api/entities", json=payload)
        r.raise_for_status()
        created.append(r.json()["id"])
        return r.json()
    yield _create
    for entity_id in created:
        api_client.delete(f"/api/entities/{entity_id}")

# Avoid: static fixture returning a fixed dict
@pytest.fixture
def entity_data():
    return {"name": "固定实体名"}  # shared, not parameterizable
```

Generate **only when** `api-codegen-plan.md` and `.aws/data-knowledge.yaml` explicitly authorize new fixture wrappers or factories.

If required capability already exists in the project or data-knowledge file, **reuse it** — do not generate a new fixture file.

必须满足：

- fixture 来源必须映射到 `.aws/data-knowledge.yaml` 中已定义的 capability。
- 不得自由发明业务状态或新建 business data factory，除非 data-knowledge 明确定义该 capability。
- 不得硬编码真实账号、密码、Token。
- 必须保留 cleanup 入口或说明 cleanup 由现有 fixture 负责。

### tests/api/helpers/<module>_api.py

Generate **only when** helper mapping in `api-codegen-plan.md` is non-empty. Do not create empty helper files.

必须满足：

- helper 只封装重复 API 调用或客户端初始化。
- helper 不得改变断言语义。
- helper 不得隐藏业务失败。

### Codegen Output Summary

codegen 完成后必须写入（create `qa/changes/<change-id>/codegen/` if it does not exist）：

```text
qa/changes/<change-id>/codegen/api-codegen-summary.md
```

必须包含：

- **Generated Files** — 实际生成或修改的文件列表（仅列出真实写入的文件；optional 文件若未生成则标注 N/A）
- **Case → Test Function Mapping** — 表格：Case ID \| Test Function \| File
- **Fixtures Generated** — fixture 名称和来源（或 "Reused existing — no new file"）
- **Helpers Generated** — helper 文件及用途（如无则 None）
- **Warnings Carried from Review** — 来自 `api-plan-review.json` 的警告（如 `codegen_readiness == "ready_with_warnings"`）
- **Known Product Issues** — 指向 `qa/changes/<change-id>/known-product-issues.md`（如存在；note if append-only)
- **Next Step** — `aws run --change <change-id>`

同时在聊天中输出摘要，但磁盘文件是 aws-run、aws-inspect 的唯一可信来源，不依赖聊天上下文。

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
- Do not create `known-product-issues.md` as the first acknowledgment of an endpoint coverage gap — that belongs to human + `aws-api-plan-reviewer` before pass.

### Test Failure Integrity

Generated tests MUST fail for the right reason.

Rules:
- Every assertion MUST map to a case assertion or plan assertion.
- Do not use `assert True`, placeholder assertions, or empty expectations.
- Do not swallow failures with empty `try/except` or `except Exception: pass`.
- Do not add fallback logic that hides product failures.
- Do not use `skip`, `xfail`, or conditional early return to make generated tests green.
- Do not loosen expected values after observing failures.
- Do not mock the behavior under test unless the plan explicitly authorizes it.
- Setup may be flexible; assertions must be strict.

Self-check before finishing codegen:
1. Would this test fail if the product behavior is wrong?
2. Does every assertion trace back to the case or plan?
3. Are setup failures reported instead of hidden?

## Workaround Policy

Do not silently change tests to avoid product bugs.

If tests use an alternate endpoint because the target endpoint has a known product bug (coverage gap):

**Prerequisites (all required before codegen):**

- `api-plan-review.json` `decision == "pass"`
- `codegen_readiness == "ready_with_warnings"`
- `qa/changes/<change-id>/known-product-issues.md` **already exists** and documents the gap
- The issue was acknowledged by `aws-api-plan-reviewer` (not deferred to codegen)

**Codegen MUST NOT** be the first writer of `known-product-issues.md` for endpoint coverage gaps. If workaround is required but `known-product-issues.md` is missing → **STOP**.

**During codegen, the skill must:**

1. Add an explicit test docstring referencing the known issue ID (e.g. `KPI-001`) and explaining the workaround.
2. Add a local comment in the test function body explaining why the alternate endpoint is used.
3. **May append** implementation-only notes to existing `known-product-issues.md` (e.g. test function name, alternate call path) — **must not** create the file or add undocumented coverage gaps.
4. Mark the direct endpoint as a coverage gap in test comments — never claim direct coverage.
5. Do **not** set execution status — that is `aws-run`'s responsibility. Existing `known-product-issues.md` enables `aws-run` to record `PASS_WITH_WARNINGS`.
6. Never claim the original endpoint is directly covered if it is not exercised successfully.

> `known-product-issues.md` is a **change-level risk record**, not an execution result. `aws-run` reads it from `qa/changes/<change-id>/known-product-issues.md` and snapshots to `execution/`.

### known-product-issues.md Template

Reference format (typically created by human + acknowledged by reviewer **before** codegen pass). Codegen may append implementation notes only — do not use this template to create the file for the first time during codegen.

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
- Endpoint path 仍处于 needs_review 或 coverage gap 未在 `known-product-issues.md` 中记录
- Workaround required but `known-product-issues.md` 缺失（codegen 不得首次创建）
- `blockers` 非空或存在 `blocking == true` 的 `needs_review` 项

## Anti-patterns

禁止：

- "Plan 文件不完整，但我先生成代码"
- "我帮你补一个 fixture 名"
- "先生成一个差不多能跑的测试"
- "Workaround 写了，但没引用已有 known-product-issues.md"
- "codegen 首次创建 known-product-issues.md 来承认 coverage gap"
- "生成空 helper / fixture 文件"
- "未经 plan 授权就改 conftest.py"
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
