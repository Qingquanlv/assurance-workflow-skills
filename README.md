# AWS — Assurance Workflow Skills

> **命名说明：** AWS 在本项目中代表 **Assurance Workflow Skills**，与 Amazon Web Services 无关。

AWS 是一套面向 AI 驱动 QA 工作流的 **CLI 工具 + Skill 套件**。它将测试基础设施脚手架、Explore 研判、Case 设计、Fact Baseline、测试规划、代码生成、执行、质量门禁、失败归因、Healing 和质量报告串联成一条**可审计、可追踪、可重放**的完整流水线。

编排层采用 **Scheme E（subagent-dispatch）**：主 Agent 只做确定性调度，各阶段由有界 Subagent 执行；CLI 负责 gate、状态机与 Quality Score，Skill 负责阶段内推理与产物写入。

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

`aws init` 会自动完成项目脚手架：创建 QA 目录结构、生成配置文件、注入 OpenCode Plugin 入口。

```bash
aws init          # 全新初始化
aws init --repair # 仅补全缺失文件，不覆盖已有配置
aws doctor        # 环境自检，输出 ok / warning / error
```

本地开发时刷新 Skill 与 CLI link：

```bash
aws skill refresh --build-link
```

---

### 2. Case 优先，Case 与脚本强联动

AWS 采用 **「先 Case，再脚本」** 的两阶段工作流。Case 按 `type` 分为四类，工作流在 **Layer Scan** 后按需启用对应层：

| Case 类型 | 测试层 | 框架 | 说明 |
|---|---|---|---|
| `API` | 功能 | pytest | 接口功能断言 |
| `E2E` | 功能 | pytest-playwright | 端到端 UI 流程 |
| `Fuzz` | 鲁棒性 | schemathesis (via pytest) | OpenAPI 驱动的边界/随机输入 |
| `Performance` | 非功能 | Locust | 绝对阈值压测（p95、error_rate） |

**主流程（按 Layer Scan 裁剪）：**

```
Phase 0 — Test Infra Bootstrap（一次性脚手架）
  └─► Phase 1.1 — Skill Registry Check
        └─► Phase 1.2 — Explore（aws-explore）
              └─► Case 设计 (aws-case-design)
                    └─► Case Review (aws-case-reviewer)
                          └─► Fact Baseline (aws-fact-baseline)
                                └─► Layer Scan — 确定 api / e2e / fuzz / performance scope
                                      ├─► API 规划 → Review → Codegen
                                      ├─► E2E 规划 → Review → Codegen
                                      ├─► Fuzz 规划 → Review → Codegen（有 Fuzz Case 时）
                                      └─► Performance 规划 → Review → Codegen（有 Performance Case 时）
                                            └─► 执行 (aws-run) → 分析 (aws-inspect)
                                                  ├─► Healing Loop（可选）
                                                  └─► 质量报告 (aws-report-generator)
                                                        └─► 归档资格建议 → aws-archive（独立触发）
```

每一个测试脚本必须与 `case.yaml` 中的 Case ID 绑定（规范格式：`TC_MODULE_001`，下划线大写）。断言来源可追溯到 Case 定义，不得自行扩展。

**执行后的完整链路：**

```
执行 (aws-run)
  └─► 结果分析 (aws-inspect)
        ├─► 修复提案 (aws-fix-proposal) → Fixer → 重新执行 …（Healing Loop，可选）
        └─► 质量报告 (aws-report-generator)
              └─► 归档 (aws-archive)
```

---

### 3. Scheme E 编排：确定性 CLI + 有界 Subagent

Phase 1.1 会探测 `task` 工具并写入 `workflow-state.yaml.execution_mode`：

| `execution_mode` | 条件 | 行为 |
|---|---|---|
| `subagent-dispatch` | `task` 工具可用 | Scheme E：主 Agent 调度，各阶段委派 Subagent |
| `inline` | `task` 不可用 | 所有阶段在主 Agent 内联执行 |

**无论哪种模式，编排器始终独占：**

- `aws status --next --json` — 下一批可调度阶段（含 `agent` / `skill` / `kind`）
- `aws gate check` — gate 裁决
- `workflow-state.yaml` 写入（Subagent 禁止修改，由权限地板 + state hash 校验保障）
- `aws run` / `aws state apply` — CLI 阶段状态落盘

Subagent 角色（`.opencode/agents/`）：

| Agent | 职责 |
|---|---|
| `aws-doc-author` | Case / Plan / Explore / Fix Proposal 等创作类阶段 |
| `aws-reviewer` | Case / Plan Review、Inspect |
| `aws-test-author` | API / E2E / Fuzz / Performance Codegen 与 Fixer |
| `aws-reporter` | 质量报告生成 |
| `aws-archiver` | 归档（独立触发，非工作流内自动执行） |

---

### 4. 每个阶段都有结构化产物落地

```
qa/changes/<change-id>/
├── proposal.md
├── workflow-state.yaml                      ← 阶段状态机 + params + execution_mode
├── events.jsonl                             ← append-only 过程审计流（UI 时间线）
├── explore/
│   ├── context.json                         ← aws risk context（CLI 聚合）
│   └── advisory.json                        ← Explore 研判 + test_strategy 提案
├── cases/<module>/case.yaml
├── facts/
│   └── fact-baseline.json                   ← 内置角色、鉴权、路由前缀等事实
├── plans/
│   ├── api-plan.md / api-codegen-plan.md
│   ├── e2e-plan.md / e2e-codegen-plan.md
│   ├── fuzz-plan.md / fuzz-codegen-plan.md
│   └── performance-plan.md / performance-codegen-plan.md
├── review/
│   ├── case-review.json
│   ├── api-plan-review.json
│   ├── plan-review.json
│   ├── fuzz-plan-review.json
│   └── performance-plan-review.json
├── codegen/
│   ├── api-codegen-summary.md
│   ├── e2e-codegen-summary.md
│   └── …
├── execution/
│   ├── execution-manifest.yaml
│   ├── api-result.json / e2e-result.json / fuzz-result.json / performance-result.json
│   ├── coverage-result.json
│   ├── quality-gate-result.json
│   ├── summary.md
│   └── runs/<batch-id>/                     ← 按批次归档，append-only
├── inspect/
│   ├── failure-analysis.json
│   ├── failure-summary.md
│   ├── quality-gate-result.json
│   └── inspect-safety-check.json
├── report/
│   ├── quality-report.json
│   ├── quality-report.md
│   └── executive-summary.md
├── healing/
│   ├── fix-proposal.json
│   ├── fixer-safety-check.json
│   └── api-apply-summary.json / e2e-apply-summary.json
└── archive/                                 ← aws-archive 产出
```

`execution/runs/<batch-id>/` 是主证据源；顶层 `execution/*.json` 为最新 run 的向后兼容指针。

---

### 5. 多级知识库，保障数据准确性

```
L1  .aws/data-knowledge.yaml            ← 项目级静态领域知识（人工维护）
      ↑ 人工 promote
L2  plans/data-knowledge.proposal.yaml  ← 规划阶段新发现（禁止直接改 L1）
      ↑ 归档后人工整理
L3  inspect/failure-analysis.json       ← 失败分类与根因
    execution/known-product-issues.md
    report/quality-report.json
      ↑ 归档后人工整理
L4  qa/archive/<change-id>/             ← 历史变更执行数据
```

Codegen 阶段**必须**存在 L1（`.aws/data-knowledge.yaml`）；`data-knowledge.proposal.yaml` 不能替代 L1。

---

### 6. 内置有界重试，Token 用量可控

```yaml
max_case_fix_attempts: 2
max_plan_fix_attempts: 2
max_healing_attempts: 2
force_continue: false   # 不得绕过 codegen 硬门禁
```

Reviewer 输出结构化 JSON；Fixer 仅处理 `auto_fix_allowed = true` 的 findings；超出上限即 STOP 并报告精确原因。

---

### 7. Skill 工程化与 Skill Load Gate

每个阶段进入前，Agent **必须从磁盘 Read 对应 SKILL.md**，并在 `workflow-state.yaml` 记录 `skill_loaded` / `skill_md_path` / `skill_loaded_at`。未通过 Skill Load Gate 不得将阶段标为 `done`。

Codegen 工程约束（`aws-api-codegen` 等）：

- 配置统一从 `tests.config.settings` 读取，禁止硬编码 URL / 凭据 / 前缀
- 复杂实体必须用 `tests.factories.make_*`，禁止裸 ORM `create()`
- Happy-path API 测试必须以 `assert_matches_schema(body, "METHOD /path")` 收尾
- Codegen **只生成代码**，不执行 pytest

这些约束依赖 Phase 0 脚手架：`tests/config.py`、`tests/conftest.py`（含 `_verify_sut_ready`）、`tests/schema_validation.py`。

---

## 工作流阶段一览

| 阶段 | Skill | Agent | 说明 |
|---|---|---|---|
| 0 | `aws-test-infra-bootstrap` | — | 一次性测试基础设施脚手架 |
| 1.1 | — | 编排器 | Skill Registry Check + `execution_mode` 探测 |
| 1.2 | `aws-explore` | `aws-doc-author` | 历史上下文 + 浅读源码 + 研判 `advisory.json` |
| 2.1 | `aws-case-design` | `aws-doc-author` | Case 增量设计 |
| 2.2 | `aws-case-reviewer` | `aws-reviewer` | Case 审查 |
| 2.3 | `aws-case-fixer` | `aws-doc-author` | Case 自动修复（条件触发） |
| 2.4 | `aws-fact-baseline` | `aws-doc-author` | 产品/环境事实基线 |
| 2.5 | — | 编排器 | Layer Scan |
| 3–6 | `aws-*-plan` / `*-reviewer` / `*-codegen` | 见 schema | 按 `test_types` 裁剪 |
| 7 | `aws-run`（CLI） | — | 测试执行 |
| 8 | `aws-inspect` | `aws-reviewer` | 失败分类 + Quality Gate |
| 9–12 | Healing skills | `aws-test-author` 等 | 可选自愈循环 |
| 13 | `aws-report-generator` | `aws-reporter` | 质量报告（非 gating） |
| 14 | — | 编排器 | 归档资格建议（不自动归档） |

正式 DAG 定义见 [`schemas/workflow-schema.yaml`](schemas/workflow-schema.yaml)。

---

## Phase 0 — Test Infra Bootstrap

在任何 change 工作流开始前，确保项目具备共享测试基础设施：

| 文件 | 作用 |
|---|---|
| `tests/config.py` | 统一 `QaSettings`（`base_url`、凭据、前缀等） |
| `tests/conftest.py` | 根 conftest + session `_verify_sut_ready` |
| `tests/schema_validation.py` | `assert_matches_schema` + `_LOCAL_SCHEMAS` |

Skill：`aws-test-infra-bootstrap` — 幂等、契约检查、缺失则创建、不合规则 STOP 询问用户，不静默覆盖。

---

## Explore（Phase 1.2，原 Risk Advisory）

在 Case 设计之前，基于 git diff、历史归档、Case 库和浅读源码生成研判：

```bash
aws risk context --change <id> [--project-dir <root>]
aws risk validate-advisory --change <id>
```

Skill：`aws-explore` — 产出 `explore/context.json`（CLI）与 `explore/advisory.json`（Skill），含 `test_strategy` 宏观方案与 per-pitfall 断言意图收集。**不**写 `case.yaml`。

---

## Fact Baseline（Phase 2.4）

Case Review 通过后、Plan 之前，收集不可臆造的产品事实：内置角色、鉴权方式、路由前缀、种子数据等。

Skill：`aws-fact-baseline` → `facts/fact-baseline.json`

---

## Fuzz / Performance 测试

与先前版本相同，按 Layer Scan 启用：

- **Fuzz**：schemathesis，`tests/fuzz/`，结果计入 functional 维度
- **Performance**：Locust 绝对阈值，`tests/perf/`，独立 non_functional 维度

详见各 `aws-fuzz-*` / `aws-performance-*` Skill。

---

## 质量报告

```bash
aws report inspect --change <id>    # 失败分类 + quality-gate-result.json
aws report generate --change <id>   # Quality Score + 报告三件套
```

Quality Score 由 CLI 确定性计算（LLM 不参与）。Gate 四态：`PASS` / `PASS_WITH_WARNINGS` / `FAIL` / `SKIPPED`，worst-wins 跨维度合并。

---

## Healing Loop

```
aws-run → aws-inspect → aws-fix-proposal → fixer → aws-run → aws-inspect →（循环 ≤ max_healing_attempts）
```

可自动修复：`locator_failure`、`wait_strategy_failure`、`test_code_error`、有条件的 `test_data_failure`。

不可自动修复：`assertion_failure`、`business_logic_failure`、`known_product_issue`、`coverage_gap`、`fuzz_*`、`perf_*` 等。

每次 Phase 10 必须接 Phase 11 re-run；每次 re-run 必须接 Phase 12 re-inspect。`Inspect Safety Gate` 与 `Fixer Safety Gate` 必须写出 evidence JSON。

---

## 快速开始

### 安装

```bash
git clone https://github.com/Qingquanlv/assurance-workflow-skills.git
cd assurance-workflow-skills
npm install && npm run build && npm link
```

### 初始化目标项目

```bash
cd your-project
aws init
```

生成：

```
.aws/config.yaml
.aws/data-knowledge.yaml
qa/cases/
qa/changes/
tests/config.py          ← Phase 0 可补全
tests/conftest.py
tests/schema_validation.py
tests/api/ tests/e2e/ tests/fuzz/ tests/perf/
```

### 环境自检

```bash
aws doctor
aws doctor --json
```

---

## CLI 命令参考

### 项目管理

| 命令 | 说明 |
|---|---|
| `aws init` | 初始化 QA 项目结构 |
| `aws init --repair` | 仅补全缺失文件 |
| `aws doctor` | 环境和配置检查 |
| `aws config print` | 查看当前配置 |

### Explore

| 命令 | 说明 |
|---|---|
| `aws risk context --change <id>` | 聚合 diff / cases / archive → `explore/context.json` |
| `aws risk validate-advisory --change <id>` | 校验 `advisory.json` 与 `context.json` |

### 测试执行与质量报告

| 命令 | 说明 |
|---|---|
| `aws run --change <id>` | 按 `selected_targets` 执行测试，写 batch 结果 |
| `aws report inspect --change <id>` | 失败分类 + `failure-analysis.json` |
| `aws report generate --change <id>` | 生成 Quality Score 与报告 |

### 工作流编排（确定性）

| 命令 | 说明 |
|---|---|
| `aws status --change <id>` | 各阶段状态（`ready` / `done` / `blocked` 等） |
| `aws status --change <id> --next` | 下一可执行阶段 |
| `aws status --change <id> --next --json` | 含 Scheme E dispatch 条目（`agent` / `skill` / `kind`） |
| `aws gate check --change <id> --phase <phase>` | 指定阶段 gate 裁决 |
| `aws state apply --change <id> --phase <phase>` | CLI 阶段完成后落盘（`execution` / `healing-rerun` / `inspect` / `report`） |

`aws status` / `aws gate check` / `aws run` 会以 best-effort 追加 `events.jsonl`，供 UI 渲染时间线；事件写入失败不改变命令退出码。

### 开发维护

| 命令 | 说明 |
|---|---|
| `aws skill refresh` | 刷新 OpenCode skill 路径与插件缓存 |
| `aws skill refresh --build-link` | 重新编译 CLI 并 npm link |
| `aws skill refresh --sync-agents` | 同步 `.opencode/agents/` + `.opencode/tools/`（含 `workflow_start`） |

---

## Skill 套件

### 编排与基础设施

| Skill | 说明 |
|---|---|
| `aws-workflow` | 完整工作流编排入口（Scheme E / inline） |
| `aws-test-infra-bootstrap` | Phase 0 测试基础设施脚手架 |
| `aws-explore` | Phase 1.2 Explore 研判 |
| `aws-dashboard` | Case Center 可视化面板 |

### Case 链路

| Skill | 说明 |
|---|---|
| `aws-case-design` | Case 增量设计 |
| `aws-case-reviewer` | Case 审查 |
| `aws-case-fixer` | Case 自动修复 |
| `aws-fact-baseline` | 产品/环境事实基线 |

### API / E2E / Fuzz / Performance

| 层 | Plan | Reviewer | Fixer | Codegen |
|---|---|---|---|---|
| API | `aws-api-plan` | `aws-api-plan-reviewer` | `aws-api-plan-fixer` | `aws-api-codegen` |
| E2E | `aws-e2e-plan` | `aws-e2e-plan-reviewer` | `aws-e2e-plan-fixer` | `aws-e2e-codegen` |
| Fuzz | `aws-fuzz-plan` | `aws-fuzz-plan-reviewer` | — | `aws-fuzz-codegen` |
| Perf | `aws-performance-plan` | `aws-performance-plan-reviewer` | — | `aws-performance-codegen` |

### 执行、分析与归档

| Skill | 说明 |
|---|---|
| `aws-run` | 调用 `aws run` 执行测试 |
| `aws-inspect` | 调用 `aws report inspect` 并分类失败 |
| `aws-report-generator` | 调用 `aws report generate` |
| `aws-archive` | 归档 Case 增量与过程产物 |

### Healing Loop

| Skill | 说明 |
|---|---|
| `aws-fix-proposal` | 生成 `fix-proposal.json` |
| `aws-api-codegen-fixer` | 修复 API 测试代码 |
| `aws-e2e-codegen-fixer` | 修复 E2E 测试代码 |

---

## OpenCode 使用方式

```text
use skill aws-workflow

Requirement:
测试菜单管理模块的增删改查功能

Run mode:
full

Test types:
api,e2e

Max case fix attempts:
2

Max plan fix attempts:
2
```

### 支持的执行模式

| 模式 | 说明 |
|---|---|
| `full` | 全流程：Explore → Case → Plan → Codegen → 执行 → Inspect → Report |
| `case-only` | Explore + Case 设计 + Review |
| `api-only` / `e2e-only` | 单层 Plan → Review → Codegen → Run |
| `plan-only` | 仅规划 + Review（需已有 Case） |
| `codegen-only` | 仅代码生成（需已有 Plan + Review pass） |
| `review-case` / `review-plan` | 仅 Review + Fix |

运行参数在 Phase 1.1 写入 `workflow-state.yaml.params`，后续 `aws status` / `aws gate check` 以此为确定性来源。

### Skill 注册

所有 Skill 通过 `skills/**/SKILL.md` 注册。Scheme E 下 Subagent 权限由 `.opencode/agents/*.md` 约束（禁止 `aws gate` / `aws status`、禁止写 `workflow-state.yaml`）。

OpenCode 安装详见 [`.opencode/INSTALL.md`](.opencode/INSTALL.md)。

---

## 失败分类速查

| 类型 | 可 Healing | 说明 |
|---|:---:|---|
| `locator_failure` | ✓ | 元素定位失效 |
| `wait_strategy_failure` | ✓ | 等待策略问题 |
| `test_code_error` | ✓ | 测试代码错误 |
| `test_data_failure` | 条件 | 测试数据问题 |
| `fuzz_configuration_error` | ✗ | Fuzz 配置问题 |
| `fuzz_stateful_failure` | review | 服务端 5xx 等 |
| `perf_threshold_exceeded` | ✗ | 压测超阈值 |
| `known_product_issue` | ✗ | 已知产品 bug |
| `coverage_gap` | ✗ | 覆盖缺口 |
| `assertion_failure` | ✗ | 断言失败（可能是产品 bug） |
| `business_logic_failure` | ✗ | 业务逻辑问题 |

---

## 开发与测试

```bash
npm run build        # 编译 TypeScript
npm test             # Jest 单元 + 集成测试
npm run lint         # tsc --noEmit
```

核心模块：

| 目录 | 说明 |
|---|---|
| `src/workflow/orchestration/` | workflow schema、DAG 引擎、`resolveNextDispatch` |
| `src/workflow/execution/` | pytest / Playwright 执行与结果解析 |
| `src/workflow/report/` | 失败分类、Quality Score、报告生成 |
| `src/risk/` | Explore context 聚合与 advisory 校验 |
| `src/workflow/core/` | workflow-state、events、case ID 规范化 |
| `skills/` | 全部 AWS Skill 定义 |
| `schemas/` | runtime schemas 与 human/agent contract references |
| `engineering/design/` | 设计方案 |

---

## 命名说明

**AWS = Assurance Workflow Skills。** 本项目与 Amazon Web Services 无任何关联。

| 术语 | 含义 |
|---|---|
| `aws-*` | 本项目 Skill 与 Agent 前缀 |
| `aws` CLI | 本项目命令行工具 |
| Explore | Phase 1.2 研判阶段（CLI 命令组仍为 `aws risk`） |

> 若本机已安装 Amazon Web Services CLI，两个 `aws` 命令可能冲突。详见 [`.opencode/INSTALL.md`](.opencode/INSTALL.md)。

---
