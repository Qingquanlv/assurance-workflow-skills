# AWS — Assurance Workflow Skills

> **命名说明：** AWS 在本项目中代表 **Assurance Workflow Skills**，与 Amazon Web Services 无关。

AWS 是一套面向 AI 驱动 QA 工作流的 **CLI 工具 + Skill 套件**。它将 case 设计、review、测试规划、代码生成、测试执行、质量门禁、失败归因和质量报告串联成一条可审计、可追踪、可重放的完整流水线。

---

## 为什么选择 AWS

### 1. 从 GitHub 安装，开箱即用

```bash
git clone https://github.com/Qingquanlv/assurance-workflow-skills.git
cd assurance-workflow-skills
npm install && npm run build && npm link
aws init
```

当前 CLI 尚未发布到 npm，需从 GitHub 克隆后本地编译安装。

`aws init` 会自动完成项目脚手架：创建 QA 目录结构、生成配置文件、注入 OpenCode Plugin 入口，无需手动配置。对多台机器和团队新成员同样友好。

```bash
aws init          # 全新初始化
aws init --repair # 仅补全缺失文件，不覆盖已有配置
aws doctor        # 环境自检，输出 ok / warning / error
```

---

### 2. Case 优先，Case 与脚本强联动

AWS 采用 **"先 Case，再脚本"** 的两阶段工作流。Case 按 `type` 分为四类，工作流在 Phase 3.6 **Layer Scan** 后按需启用对应层：

| Case 类型 | 测试层 | 框架 | 说明 |
|---|---|---|---|
| `API` | 功能 | pytest | 接口功能断言 |
| `E2E` | 功能 | pytest-playwright | 端到端 UI 流程 |
| `Fuzz` | 鲁棒性 | schemathesis (via pytest) | OpenAPI 驱动的边界/随机输入，验证无 5xx、不误拒合法输入 |
| `Performance` | 非功能 | Locust | 绝对阈值压测（p95、error_rate），不做历史基线对比 |

**主流程（按 Layer Scan 裁剪）：**

```
需求分析
  └─► Case 设计 (aws-case-design)
        └─► Case Review (aws-case-reviewer)
              └─► Layer Scan — 确定 api / e2e / fuzz / performance 是否在 scope
                    ├─► API 规划 → Review → Codegen (aws-api-plan / -reviewer / -codegen)
                    ├─► E2E 规划 → Review → Codegen (aws-e2e-plan / -reviewer / -codegen)
                    ├─► Fuzz 规划 → Review → Codegen (aws-fuzz-plan / -reviewer / -codegen)      ← 有 Fuzz Case 时
                    └─► Performance 规划 → Review → Codegen (aws-performance-plan / …)             ← 有 Performance Case 时
                          └─► 执行 (aws-run) → 分析 (aws-inspect) → 质量报告 (aws-report-generator)
```

每一个测试脚本必须与 `case.yaml` 中的 Case ID 绑定，断言来源可追溯到 Case 定义，不得自行扩展。这样做的好处：

- **脚本准确率更高**：脚本严格按 Case 断言生成，杜绝 AI 自由发挥
- **功能覆盖率可量化**：通过 Case 的自动化通过率直接反映功能覆盖度
- **Case 变更同步脚本**：Case 修改后，脚本随之重新生成，二者始终一致

**执行后的完整链路：**

```
执行 (aws-run)
  └─► 结果分析 (aws-inspect)
        ├─► 修复提案 (aws-fix-proposal) → Fixer → 重新执行 …（Healing Loop，可选）
        └─► 质量报告 (aws-report-generator)   ← 终端非 gating 阶段
              └─► 归档 (aws-archive)
```

---

### 3. 每个阶段都有结构化产物落地

AWS 在每个工作流阶段都输出具体文件，不依赖对话记忆：

```
qa/changes/<change-id>/
├── proposal.md                              ← 需求分析 & 范围确认
├── workflow-state.yaml                      ← 阶段状态机 + selected_targets / layers
├── cases/<module>/case.yaml                 ← Case 增量（ADDED / MODIFIED / REMOVED）
├── plans/
│   ├── api-plan.md                          ← API 测试设计
│   ├── api-codegen-plan.md
│   ├── e2e-plan.md                          ← E2E 测试设计
│   ├── e2e-codegen-plan.md
│   ├── fuzz-plan.md                         ← Fuzz 测试设计（有 Fuzz Case 时）
│   ├── fuzz-codegen-plan.md
│   ├── performance-plan.md                  ← Performance 测试设计（有 Performance Case 时）
│   └── performance-codegen-plan.md
├── review/
│   ├── case-review.json
│   ├── api-plan-review.json
│   ├── fuzz-plan-review.json                ← 有 Fuzz 时
│   └── performance-plan-review.json         ← 有 Performance 时
├── execution/
│   ├── execution-manifest.yaml              ← 最新 run 的 batch 指针 + selected_targets
│   ├── api-result.json                      ← 最新 run 指针（向后兼容）
│   ├── e2e-result.json
│   ├── fuzz-result.json
│   ├── performance-result.json
│   ├── coverage-result.json                 ← API pytest 衍生；api 未选时为 SKIPPED
│   ├── quality-gate-result.json             ← 统一质量门禁结论
│   ├── summary.md                           ← 人类可读执行摘要（含 Final Gate 行）
│   ├── known-product-issues.md              ← 已知产品 bug（如有）
│   └── runs/<batch-id>/                     ← 按批次归档，append-only，不覆盖
│       ├── api-result.json
│       ├── e2e-result.json
│       ├── fuzz-result.json
│       ├── performance-result.json
│       ├── coverage-result.json
│       ├── quality-gate-result.json
│       ├── execution-manifest.yaml
│       ├── summary.md
│       ├── raw/                             ← pytest / locust 原始日志
│       ├── traces/                          ← E2E Playwright trace
│       ├── screenshots/
│       └── videos/
├── inspect/
│   ├── failure-analysis.json                ← 失败分类 + coverage_gaps + inspect_mode
│   ├── failure-summary.md
│   └── quality-gate-result.json             ← inspect 阶段 gate（供 report 消费）
├── report/                                  ← aws report generate 产出
│   ├── quality-report.json                  ← 结构化报告 + Quality Score
│   ├── quality-report.md                    ← 完整质量报告
│   └── executive-summary.md                 ← 一页纸结论
├── healing/                                   ← Healing Loop 产物（如触发）
│   ├── fix-proposal.json
│   ├── fixer-safety-check.json
│   ├── api-apply-result.json
│   └── e2e-apply-result.json
└── archive/                                   ← 归档副本（见第 7 点）
```

产物文件既是工作流的决策依据，也是团队的审计证据。`execution/runs/<batch-id>/` 是主证据源；顶层 `execution/*.json` 仅为最新 run 的向后兼容指针。

---

### 4. 多级知识库，保障数据准确性

AWS 采用**四层知识库体系**，从静态配置到执行历史形成完整的知识积累链路：

```
L1  .aws/data-knowledge.yaml            ← 项目级静态领域知识（人工维护）
      ↑ 人工 promote
L2  plans/data-knowledge.proposal.yaml  ← 规划阶段新发现的知识（自动写入，禁止直接改 L1）
      ↑ 归档后人工整理
L3  inspect/failure-analysis.json       ← 执行失败分类与根因（aws report inspect 自动生成）
    execution/known-product-issues.md     ← 已知产品 Bug 记录
    report/quality-report.json            ← 质量评分与风险结论（aws report generate）
      ↑ 归档后人工整理
L4  qa/archive/<change-id>/             ← 历史变更执行数据（长期沉淀，跨 change 参考）
```

**L1 — 静态领域知识 (`.aws/data-knowledge.yaml`)**

记录：测试账号与权限级别、业务实体状态（菜单、用户、角色）、Fixture / Factory 策略、Auth 机制和 Token 来源。

所有 Codegen Skill 生成代码前必须先读取此文件，确保 Fixture 有据可查、Auth 不被猜测、造数脚本与真实业务匹配。

**L2 — 规划阶段发现 (`data-knowledge.proposal.yaml`)**

当 Plan Skill 在规划过程中发现 L1 中未记录的新实体、新接口、新 Fixture 需求时，自动写入 `proposal`。Skill 被明确禁止直接修改 L1，人工确认后由团队 promote。

**L3 — 执行与质量数据（自动生成）**

- `aws report inspect` → `inspect/failure-analysis.json`：每条失败的分类、根因、`fix_proposal_eligible` 标记和 `source_batch_id`
- `aws report generate` → `report/quality-report.json`：确定性 Quality Score（0–100）、四维 breakdown、缺陷分桶、风险等级与发布建议
- 若测试使用 workaround 绕过了产品 bug，`known-product-issues.md` 会被写入并随归档保存

**L4 — 跨 Change 历史沉淀 (`qa/archive/`)**

每次 archive 后，所有执行数据（plans / review / execution / inspect / report / known issues）完整归档。随着项目积累，历史归档数据成为新 change 造数规划和风险评估的参考来源。

> 知识反哺设计原则：L2/L3/L4 的产物不会自动写入 L1，必须经人工审核后 promote，避免脏数据污染核心知识库。

---

### 5. 内置重试机制，Token 用量可控

AWS 对每个可能失败的工作流节点都设置了**有界重试策略**：

```yaml
max_case_fix_attempts: 2    # Case 最多自动修复 2 次
max_plan_fix_attempts: 2    # Plan 最多自动修复 2 次
max_case_reviewer_calls: 3  # Reviewer 最多调用 3 次（含初次）
max_plan_reviewer_calls: 3
force_continue: false        # 超出限制后必须人工介入
```

**工作机制：**

- Reviewer 输出结构化 JSON（不依赖自然语言判断）
- Fixer 仅处理 `auto_fix_allowed = true` 的 findings，不擅自改动产品逻辑
- 超出最大次数 → 停止，报告精确 stop reason，等待人工处理
- 任何节点失败都不会绕过 Review Gate 继续推进

**效果：** 稳定通过时零人工介入；真正的产品问题在有限轮次内暴露，不会出现无限循环消耗 Token 的情况。

---

### 6. Skill 体系经过工程化提炼，写法标准

AWS 的 Skill 设计参考了以下优秀实践：

- **[Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)**：基于 schema 的变更工作流框架（OPSX），提供 artifact DAG、依赖拓扑排序、`openspec status` 状态机，以及可 fork / 自定义 schema 的工程化 AI 协作模式
- **[obra/superpowers](https://github.com/obra/superpowers)**：结构化 Skill 编写规范，强调 frontmatter + 明确 trigger + 输出契约

在此基础上，AWS 针对 **API + E2E + Fuzz + Performance 测试流水线** 进行了工程化改进：

| 设计原则 | 实现方式 |
|---|---|
| 测试知识结构化 | Skill 明确定义 When to Use / Do Not Use / Stop Conditions |
| 审查与执行分离 | Reviewer 只读，Fixer 只改，Codegen 只在 gate pass 后运行 |
| 输出契约化 | 每个 Skill 有 Output Contract，规定必须写哪些文件、必须包含哪些字段 |
| CLI 是唯一可信层 | 执行结果、Coverage、Quality Score、Gate 结论均由 CLI 计算，Skill 只验证不伪造 |
| Known Issue 显式化 | 测试 workaround 必须写 `known-product-issues.md`，不允许静默绕过 |
| Gate 机器可读 | 所有 Review 结论写入 JSON，不依赖自然语言批准 |

---

### 7. 全流程归档，知识沉淀可追溯

每次工作流结束后，`aws-archive` 负责：

1. **合并 Case 增量** → `qa/cases/<module>/case.yaml`（稳定主资产，ADDED / MODIFIED / REMOVED 语义合并）
2. **保留测试代码** → `tests/api/` `tests/e2e/` `tests/fuzz/` `qa/perf/`（长期可执行）
3. **归档过程产物** → `qa/archive/<change-id>/`（plans / review / execution / inspect / report 全量备份）
4. **生成归档摘要** → `qa/archive/<change-id>/archive-summary.md`

归档摘要包含：Case 变更统计、Review gate 决策、执行状态、Quality Score、已知产品问题清单，是团队 QA 知识库的核心沉淀。

> 若测试通过但存在已知产品 bug（workaround 绕过），归档状态为 `archived_with_known_issues`，永远不会写成 clean pass，确保后续追踪。

---

## Fuzz 测试（M3）

Fuzz 层验证 API 在**边界输入和 schema 衍生输入**下的鲁棒性，不替代功能断言。

**何时启用：** Case Delta 中存在 `type: Fuzz` 且 `automation.required: true` 的 Case。Layer Scan 会将 `layers.fuzz = true` 写入 `workflow-state.yaml`。

**工作流阶段：**

| 阶段 | Skill | 产出 |
|---|---|---|
| 规划 | `aws-fuzz-plan` | `plans/fuzz-plan.md`, `fuzz-codegen-plan.md` |
| 审查 | `aws-fuzz-plan-reviewer` | `review/fuzz-plan-review.json` |
| 代码生成 | `aws-fuzz-codegen` | `tests/fuzz/test_*.py`（schemathesis） |
| 执行 | `aws-run`（`selected_targets.fuzz = true`） | `fuzz-result.json` |
| 分析 | `aws-inspect` | `fuzz_configuration_error` / `fuzz_stateful_failure` 等分类 |

**Case 约束：**

- 每个 Fuzz Case 必须声明 `automation.fuzz.endpoints` 和 `related_cases`（指向对应 API 功能 Case）
- Fuzz 失败中的 **5xx / schema violation** 通常归类为产品鲁棒性问题（`fuzz_stateful_failure`），不进入自动 Fix Proposal
- Fuzz 结果计入 Quality Gate 的 **functional** 维度（与 API/E2E 并列 worst-wins）

**测试代码位置：** `tests/fuzz/`

---

## Performance 测试（M3）

Performance 层使用 Locust 做**绝对阈值**压测，不做历史基线回归对比。

**何时启用：** Case Delta 中存在 `type: Performance` 且 `automation.required: true` 的 Case，且 Case 中已确认 `automation.performance.scenario.thresholds`（`p95_ms`、`error_rate_max`）。

**工作流阶段：**

| 阶段 | Skill | 产出 |
|---|---|---|
| 规划 | `aws-performance-plan` | `plans/performance-plan.md`, `performance-codegen-plan.md` |
| 审查 | `aws-performance-plan-reviewer` | `review/performance-plan-review.json` |
| 代码生成 | `aws-performance-codegen` | `qa/perf/locustfile*.py` |
| 执行 | `aws-run`（`selected_targets.performance = true`） | `performance-result.json`（含 per-scenario verdict） |
| 分析 | `aws-inspect` | `perf_threshold_exceeded` 进入 `needs_review`，不自动修复 |

**配置（`.aws/config.yaml`）：**

```yaml
performance:
  enabled: true
  base_url: http://localhost:8000
  default_load:
    users: 10
    spawn_rate: 2
    run_time_s: 30
```

Case 可在 `automation.performance.scenario.load` 中覆盖默认负载；不同 load profile 会分组执行 Locust，各自独立判定阈值。

**Quality Gate：** Performance 形成独立的 **non_functional** 维度；任一 scenario `verdict: FAIL` → gate `FAIL`。

---

## 质量报告（M1 + M3）

质量报告在执行 + inspect 完成后生成，为研发提供可读的发布决策依据。

**CLI 命令：**

```bash
aws report inspect --change <id>    # 必须先执行：失败分类 + quality-gate-result.json
aws report generate --change <id>   # 生成 Quality Score 与报告
```

**Skill：** `aws-report-generator`（工作流 Phase 13.5，终端非 gating）

**产出：**

| 文件 | 内容 |
|---|---|
| `report/quality-report.json` | 结构化报告：`quality_score`、`score_breakdown`、`defects`、`risk_level`、`recommendation` |
| `report/quality-report.md` | 完整报告：Functional / Coverage / Fuzz / Non-Functional 各章 |
| `report/executive-summary.md` | 一页纸：Final Status + Score + 风险 + 发布建议 |

**Quality Score（CLI 确定性计算，LLM 不参与）：**

| 场景 | 权重 |
|---|---|
| 仅 API + E2E（无 Fuzz/Performance） | Functional 70% + Coverage 30% |
| 含 Fuzz 和/或 Performance | Functional 50% + Coverage 20% + Fuzz 15% + Performance 15% |

未运行的维度记为 `N/A`，CLI 对活跃维度 renormalize 到 100 分。

**Quality Gate 四态（worst-wins 跨维度）：**

| 状态 | 含义 |
|---|---|
| `PASS` | 所有活跃维度通过 |
| `PASS_WITH_WARNINGS` | 功能通过，Coverage 低于阈值（warn 模式）等警告 |
| `FAIL` | 功能失败、Coverage block 模式未达标、Performance 超阈值等 |
| `SKIPPED` | 无目标被选中或全部 SKIPPED |

**Coverage 说明：**

- Coverage 随 API pytest 采集（`pytest-cov`），不是独立 selected target
- `api=false` 时写 `coverage-result.json` 且 `skip_reason: api_unselected`
- `coverage.gate_mode: warn`（默认）→ 低于阈值为 `PASS_WITH_WARNINGS`；`block` → `FAIL`

---

## 快速开始

### 安装

从 GitHub 克隆并安装 CLI：

```bash
git clone https://github.com/Qingquanlv/assurance-workflow-skills.git
cd assurance-workflow-skills
npm install && npm run build && npm link
```

已在仓库目录内开发时，只需重新编译并刷新 link：

```bash
npm run build && npm link
```

### 初始化项目

```bash
cd your-project
aws init
```

生成：

```
.aws/config.yaml              ← 项目配置（含 coverage / performance 段）
.aws/data-knowledge.yaml      ← 数据知识库（需填充）
qa/cases/                     ← Case 主资产目录
qa/changes/                   ← 变更工作目录
qa/perf/                      ← Locust locustfile（Performance codegen 产出）
tests/api/                    ← API 测试代码
tests/e2e/                    ← E2E 测试代码
tests/fuzz/                   ← Fuzz 测试代码（schemathesis）
tests/fixtures/               ← Fixture 脚本
```

### 环境自检

```bash
aws doctor           # 输出 ok / warning / error
aws doctor --json    # 机器可读 JSON
```

---

## CLI 命令参考

### 项目管理

| 命令 | 说明 |
|---|---|
| `aws init` | 初始化 QA 项目结构 |
| `aws init --repair` | 仅补全缺失文件 |
| `aws doctor` | 环境和配置检查 |
| `aws doctor --json` | JSON 格式检查结果 |
| `aws config print` | 查看当前配置 |

### 测试执行与质量报告

| 命令 | 说明 |
|---|---|
| `aws run --change <id>` | 按 `selected_targets` 执行 API / E2E / Fuzz / Performance，写 batch 结果 + Quality Gate |
| `aws report inspect --change <id>` | 分析执行结果，分类失败，写 `failure-analysis.json` + `quality-gate-result.json` |
| `aws report generate --change <id>` | 生成 Quality Score 与质量报告（需先 inspect） |

### 工作流编排（影子模式）

这两个命令由 `aws-workflow` Skill 在每个阶段完成后自动调用，用于校验 LLM 决策与确定性状态机的一致性。

| 命令 | 说明 |
|---|---|
| `aws status --change <id>` | 输出当前工作流各阶段状态（`ready` / `done` / `blocked` 等） |
| `aws status --change <id> --next` | 仅输出下一个可执行阶段 |
| `aws gate check --change <id> --phase <phase>` | 对指定阶段执行 gate 裁决（`pass` / `stop` / `needs_fix` 等） |
| `aws gate check --change <id> --phase <phase> --json` | JSON 格式 gate 结果 |

### 开发维护

| 命令 | 说明 |
|---|---|
| `aws skill refresh` | 清除 OpenCode 中 AWS skill 包缓存，重启后生效 |
| `aws skill refresh --dry-run` | 预览待删除缓存，不实际执行 |
| `aws skill refresh --build-link` | 同时重新编译 CLI 并刷新 npm link（本地开发用） |

**典型执行链路：**

```bash
aws run --change REQ-002-menu-management
aws report inspect --change REQ-002-menu-management
aws report generate --change REQ-002-menu-management
aws status --change REQ-002-menu-management
aws gate check --change REQ-002-menu-management --phase codegen
```

`aws run` 退出码：`PASS` / `PASS_WITH_WARNINGS` → 0；`FAIL` 或全部 selected target SKIPPED → 1。

---

## Skill 套件

### 主流程

| Skill | 阶段 | 说明 |
|---|:---:|---|
| `aws-workflow` | 入口 | 完整工作流编排（可按阶段 / Layer 裁剪） |
| `aws-case-design` | 1 | 需求分析 → 生成 Case 增量 YAML |
| `aws-case-reviewer` | 2 | Case 质量审查，输出 `case-review.json` |
| `aws-case-fixer` | 3 | 按 Review 建议自动修复 Case |
| `aws-api-plan` | 4A | API 测试规划（endpoint、断言、数据） |
| `aws-api-plan-reviewer` | 5A | API Plan 审查 |
| `aws-api-plan-fixer` | 6A | 按 Review 建议修复 API Plan |
| `aws-api-codegen` | 7A | 根据 Plan 生成 pytest 测试代码 |
| `aws-e2e-plan` | 4B | E2E 测试规划（Python Playwright） |
| `aws-e2e-plan-reviewer` | 5B | E2E Plan 审查 |
| `aws-e2e-plan-fixer` | 6B | 按 Review 建议修复 E2E Plan |
| `aws-e2e-codegen` | 7B | 根据 Plan 生成 Playwright 测试代码 |
| `aws-fuzz-plan` | 4C | Fuzz 测试规划（schemathesis，有 Fuzz Case 时） |
| `aws-fuzz-plan-reviewer` | 5C | Fuzz Plan 审查 |
| `aws-fuzz-codegen` | 7C | 生成 Fuzz 测试代码 |
| `aws-performance-plan` | 4D | Performance 测试规划（Locust 绝对阈值） |
| `aws-performance-plan-reviewer` | 5D | Performance Plan 审查 |
| `aws-performance-codegen` | 7D | 生成 Locust locustfile |
| `aws-run` | 8/12 | 调用 `aws run` 执行测试并汇报 |
| `aws-inspect` | 9/13 | 调用 `aws report inspect` 并分类失败原因 |
| `aws-report-generator` | 13.5 | 调用 `aws report generate` 生成质量报告 |
| `aws-archive` | 14 | 归档 Case 增量 + 过程产物 |

### Healing Loop（自动修复循环）

| Skill | 阶段 | 说明 |
|---|:---:|---|
| `aws-fix-proposal` | 10 | 分析失败分类，生成结构化修复提案 `fix-proposal.json` |
| `aws-api-codegen-fixer` | 11A | 按提案修复 API 测试代码（含 Risk Gate，高风险需人工确认） |
| `aws-e2e-codegen-fixer` | 11B | 按提案修复 E2E 测试代码（含 Risk Gate，高风险需人工确认） |

> Healing Loop 仅覆盖 API / E2E 测试代码修复。Fuzz 配置错误和 Performance 超阈值需人工 review，不进入自动 fix。

### 工具

| Skill | 说明 |
|---|---|
| `aws-dashboard` | 打开 Case Center 可视化面板 |

---

## OpenCode 使用方式

**默认（inline）：** 在 primary agent 中通过 Skill 触发完整工作流：

```
use skill aws-workflow

Requirement:
测试菜单管理模块的增删改查功能

Run mode:
full

Max case fix attempts:
2

Max plan fix attempts:
2
```

Primary agent 在同一上下文中 inline 加载各阶段 Skill，不使用 subagent。

### Hybrid 工作流（v0.2 可选）

**Inline 仍是默认路径。** Hybrid 为 opt-in，需先完成 OpenCode 初始化：

```bash
aws init --agent opencode --yes
```

初始化会复制 `.opencode/agents`（含 `aws-conductor`）、`commands`、`skills`、`hybrid-phase-map.yaml` 及本地插件 `.opencode/plugins/aws.mjs`。

启用 hybrid 的两种方式：

1. 将 primary agent 选为 `aws-conductor`，并要求运行 hybrid 工作流
2. 在 `qa/changes/<change-id>/workflow-state.yaml` 中设置 `execution_mode: hybrid`

Conductor 加载阶段 Skill、生成 task brief、通过角色 subagent 委派阶段工作，并由 CLI（`aws status`、`aws gate check`）裁决调度与门禁。阶段 slash command（`/aws-*`）仅供 Conductor 委派使用，**不能**作为独立入口直接运行；若缺少 Conductor 生成的 task brief，应提示用户从 `aws-conductor` 启动工作流（用户可见文案不暴露内部 skill 名称）。

适用场景：需要 subagent 并行批次、严格 brief/audit 边界时选用 hybrid；单 agent 简单流程继续使用 inline 即可。

详见 [.opencode/INSTALL.md](.opencode/INSTALL.md)。

### 支持的执行模式

| 模式 | 说明 |
|---|---|
| `full` | 全流程：case 设计 → review → 规划 → review → codegen → 执行 → inspect → report |
| `case-only` | 仅 Case 设计 + Review |
| `plan-only` | 仅规划 + Review（依赖已有 Case）|
| `codegen-only` | 仅代码生成（依赖已有 Plan）|
| `review-case` | 仅 Case Review + Fix |
| `review-plan` | 仅 Plan Review + Fix |

### Skill 架构

所有 Skill 均通过 `skills/**/SKILL.md` 注册，OpenCode 在启动时自动扫描加载。

- **Inline（默认）：** 不使用 `.opencode/agents` 或 `/aws-*` slash command；primary agent inline 执行各阶段 Skill。
- **Hybrid（opt-in）：** 使用 `aws-conductor` 与六个角色 subagent，由 Conductor 委派；阶段 command 为委派模板，非独立入口。需 `aws init --agent opencode` 提供的 hybrid 资产。

**职责边界：**

- **Reviewer**：只读，输出结构化 JSON，永不修改 Case / Plan 文件
- **Fixer**：只处理 `auto_fix_allowed = true` 的 findings，不发明产品行为
- **Codegen Fixer**：只修改授权范围内的测试文件，高风险提案需人工确认
- **Report Generator**：调用 CLI 生成报告，不重新计算 Quality Score 或 final_status
- **Inline：** 所有阶段在 primary agent 内联执行，不通过 subagent 加载 Skill
- **Hybrid：** Conductor 加载 Skill 并委派 subagent；subagent 仅按 task brief 执行，不加载 Skill

**确定性编排（影子模式）：**

`aws-workflow` 在每个阶段完成后调用 `aws status` 和 `aws gate check`，对比 CLI 确定性状态机与 LLM 决策的一致性。不一致时记录到 `workflow-state.yaml` 的 `agent_warnings[]`，不影响当前执行，但可用于后续分析和 Skill 迭代。

底层基于 `docs/design/workflow-schema.yaml` 描述的 DAG 和 predicate mini-DSL，Gate 裁决完全由 CLI 确定性计算，不依赖 LLM 判断。

---

## 失败分类与 Healing Loop

`aws report inspect` 对每条失败进行分类，结果写入 `inspect/failure-analysis.json`：

| 类型 | `fix_proposal_eligible` | 说明 |
|---|:---:|---|
| `locator_failure` | ✓ | 元素定位失效 |
| `wait_strategy_failure` | ✓ | 等待策略问题 |
| `test_code_error` | ✓ | 测试代码错误 |
| `test_data_failure` | review | 测试数据问题 |
| `fuzz_configuration_error` | ✗ | Fuzz 配置/Schema 问题，修 setup 不重跑 auto-fix |
| `fuzz_stateful_failure` | review | Fuzz 发现服务端故障（5xx 等），可能是产品 bug |
| `perf_threshold_exceeded` | ✗ | Performance p95 / error_rate 超绝对阈值，需人工 review |
| `perf_environment` | ✗ | 压测环境不可达 / 无流量 |
| `known_product_issue` | ✗ | 已知产品 bug，需产品修复 |
| `coverage_gap` | ✗ | 覆盖缺口，不进入 auto-fix |
| `manifest_asset_missing` | ✗ | manifest 声明的 target 结果文件缺失，需重新 run |
| `environment_failure` | ✗ | 环境问题 |
| `assertion_failure` | ✗ | 断言失败，可能是产品 bug |
| `business_logic_failure` | ✗ | 业务逻辑问题 |
| `case_semantic_failure` | ✗ | Case 语义问题 |

`fix_proposal_eligible = true` 的失败会进入 Healing Loop：`aws-fix-proposal` 生成提案 → Fixer 修复代码 → 重新执行 → 重新 inspect，循环最多 `max_healing_attempts` 轮。Healing Loop 不会修改 Case 文件和业务逻辑，只修正测试代码本身的缺陷。

**Healing 状态机：**

```
pending → not_needed         (无 eligible 失败)
        → proposal_created   (fix-proposal 完成)
             → applied       (fixer 应用完成)
                  → resolved (rerun 后测试通过)
                  → exhausted(达到最大轮次，仍有失败)
        → skipped            (高风险提案，跳过自动应用)
        → failed             (fixer 执行异常)
```

Healing 完成后（或跳过后），工作流继续进入 **Report Generation** → **Archive**。

---

## 命名说明

**AWS = Assurance Workflow Skills。** 本项目与 Amazon Web Services 无任何关联。

| 术语 | 含义 |
|---|---|
| `aws-*` 前缀 | 本项目所有 Skill 和 Agent 的命名前缀 |
| `aws` CLI | 本项目的命令行工具 |
| AWS 项目 | Assurance Workflow Skills |

> 若本机已安装 Amazon Web Services CLI，两个 `aws` 命令会产生冲突。详见 [.opencode/INSTALL.md](.opencode/INSTALL.md) 中的处理建议。

---
