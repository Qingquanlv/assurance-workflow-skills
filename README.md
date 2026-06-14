# AWS — Assurance Workflow Skills

> **命名说明：** AWS 在本项目中代表 **Assurance Workflow Skills**，与 Amazon Web Services 无关。

AWS 是一套面向 AI 驱动 QA 工作流的 **CLI 工具 + Skill 套件**。它将 case 设计、review、测试规划、代码生成、测试执行和失败归因串联成一条可审计、可追踪、可重放的完整流水线。

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

AWS 采用 **"先 Case，再脚本"** 的两阶段工作流：

```
需求分析
  └─► Case 设计 (aws-case-design)
        └─► Case Review (aws-case-reviewer)
              └─► API 测试规划 (aws-api-plan)
                    └─► API Plan Review (aws-api-plan-reviewer)
                          └─► 生成 pytest 脚本 (aws-api-codegen)
                                └─► 执行 & 结果 (aws-run / aws-inspect)
```

每一个测试脚本必须与 `case.yaml` 中的 Case ID 绑定，断言来源可追溯到 Case 定义，不得自行扩展。这样做的好处：

- **脚本准确率更高**：脚本严格按 Case 断言生成，杜绝 AI 自由发挥
- **功能覆盖率可量化**：通过 Case 的自动化通过率直接反映功能覆盖度
- **Case 变更同步脚本**：Case 修改后，脚本随之重新生成，二者始终一致

工作流现已扩展到执行后的**自动修复循环（Healing Loop）**：

```
执行 (aws-run)
  └─► 结果分析 (aws-inspect)
        └─► 修复提案 (aws-fix-proposal)
              └─► 代码修复 (aws-api-codegen-fixer / aws-e2e-codegen-fixer)
                    └─► 重新执行 → 重新分析 → …（最多 N 轮）
```

---

### 3. 每个阶段都有结构化产物落地

AWS 在每个工作流阶段都输出具体文件，不依赖对话记忆：

```
qa/changes/<change-id>/
├── proposal.md                         ← 需求分析 & 范围确认
├── cases/<module>/case.yaml            ← Case 增量（ADDED / MODIFIED / REMOVED）
├── plans/
│   ├── api-plan.md                     ← API 测试设计
│   ├── api-test-data-plan.md           ← 测试数据规划
│   └── api-codegen-plan.md             ← 代码生成映射表
├── review/
│   ├── case-review.json                ← Case 审查 gate（机器可读）
│   └── api-plan-review.json            ← Plan 审查 gate（机器可读）
├── execution/
│   ├── api-result.json                 ← pytest 执行结果（标准化）
│   ├── e2e-result.json                 ← Playwright 执行结果（标准化）
│   ├── summary.md                      ← 人类可读执行摘要
│   └── known-product-issues.md         ← 已知产品 bug 记录（如有）
├── inspect/
│   ├── failure-analysis.json           ← 失败分类（aws report inspect 生成）
│   ├── failure-summary.md              ← 人类可读失败摘要
│   └── inspect-safety-check.json       ← Inspect Safety Gate 审计证据
├── healing/                            ← Healing Loop 产物（如触发）
│   ├── fix-proposal.json               ← 结构化修复提案
│   ├── fixer-safety-check.json         ← Fixer Safety Gate 审计证据
│   ├── api-apply-result.json           ← API fixer 应用结果
│   └── e2e-apply-result.json           ← E2E fixer 应用结果
└── archive/                            ← 归档副本（见第 7 点）
```

产物文件既是工作流的决策依据，也是团队的审计证据。

---

### 4. 多级知识库，保障数据准确性

AWS 采用**四层知识库体系**，从静态配置到执行历史形成完整的知识积累链路：

```
L1  .aws/data-knowledge.yaml            ← 项目级静态领域知识（人工维护）
      ↑ 人工 promote
L2  plans/data-knowledge.proposal.yaml  ← 规划阶段新发现的知识（自动写入，禁止直接改 L1）
      ↑ 归档后人工整理
L3  execution/failure-analysis.json     ← 执行失败分类与根因（aws inspect 自动生成）
    execution/known-product-issues.md   ← 已知产品 Bug 记录（codegen 发现 workaround 时写入）
      ↑ 归档后人工整理
L4  qa/archive/<change-id>/             ← 历史变更执行数据（长期沉淀，跨 change 参考）
```

**L1 — 静态领域知识 (`.aws/data-knowledge.yaml`)**

记录：测试账号与权限级别、业务实体状态（菜单、用户、角色）、Fixture / Factory 策略、Auth 机制和 Token 来源。

所有 Codegen Skill 生成代码前必须先读取此文件，确保 Fixture 有据可查、Auth 不被猜测、造数脚本与真实业务匹配。

**L2 — 规划阶段发现 (`data-knowledge.proposal.yaml`)**

当 Plan Skill 在规划过程中发现 L1 中未记录的新实体、新接口、新 Fixture 需求时，自动写入 `proposal`。Skill 被明确禁止直接修改 L1，人工确认后由团队 promote。

**L3 — 执行失败数据（自动生成）**

`aws report inspect` 执行后写入 `inspect/failure-analysis.json`，包含每条失败的分类、根因、`fix_proposal_eligible` 标记和 `source_batch_id`（用于 healing loop 的批次绑定校验）。若测试使用 workaround 绕过了产品 bug，`known-product-issues.md` 会被自动写入并随归档保存，作为后续 change 的历史参考。

**L4 — 跨 Change 历史沉淀 (`qa/archive/`)**

每次 archive 后，所有执行数据（plans / review / execution / known issues）完整归档。随着项目积累，历史归档数据成为新 change 造数规划和风险评估的参考来源。

> 知识反哺设计原则：L2/L3/L4 的产物不会自动写入 L1，必须经人工审核后 promote，避免脏数据污染核心知识库。知识库与项目共同演进：每次 archive 后，建议团队检查是否有新发现的实体或接口需要更新 `data-knowledge.yaml`。

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

在此基础上，AWS 针对 **API + E2E 测试流水线** 进行了工程化改进：

| 设计原则 | 实现方式 |
|---|---|
| 测试知识结构化 | Skill 明确定义 When to Use / Do Not Use / Stop Conditions |
| 审查与执行分离 | Reviewer 只读，Fixer 只改，Codegen 只在 gate pass 后运行 |
| 输出契约化 | 每个 Skill 有 Output Contract，规定必须写哪些文件、必须包含哪些字段 |
| Known Issue 显式化 | 测试 workaround 必须写 `known-product-issues.md`，不允许静默绕过 |
| Gate 机器可读 | 所有 Review 结论写入 JSON，不依赖自然语言批准 |

---

### 7. 全流程归档，知识沉淀可追溯

每次工作流结束后，`aws-archive` 负责：

1. **合并 Case 增量** → `qa/cases/<module>/case.yaml`（稳定主资产，ADDED / MODIFIED / REMOVED 语义合并）
2. **保留测试代码** → `tests/api/` `tests/e2e/`（长期可执行）
3. **归档过程产物** → `qa/archive/<change-id>/`（plans / review / execution 全量备份）
4. **生成归档摘要** → `qa/archive/<change-id>/archive-summary.md`

归档摘要包含：Case 变更统计、Review gate 决策、执行状态、已知产品问题清单，是团队 QA 知识库的核心沉淀。

> 若测试通过但存在已知产品 bug（workaround 绕过），归档状态为 `archived_with_known_issues`，永远不会写成 clean pass，确保后续追踪。

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
.aws/config.yaml              ← 项目配置
.aws/data-knowledge.yaml      ← 数据知识库（需填充）
qa/cases/                     ← Case 主资产目录
qa/changes/                   ← 变更工作目录
tests/api/                    ← API 测试代码
tests/e2e/                    ← E2E 测试代码
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

### 测试执行

| 命令 | 说明 |
|---|---|
| `aws run --change <id>` | 执行指定 change 的测试 |
| `aws report inspect --change <id>` | 分析执行结果，生成失败分类报告 |

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

示例：

```bash
aws run --change REQ-002-menu-management
aws report inspect --change REQ-002-menu-management
aws status --change REQ-002-menu-management
aws gate check --change REQ-002-menu-management --phase codegen
```

---

## Skill 套件

### 主流程

| Skill | 阶段 | 说明 |
|---|:---:|---|
| `aws-workflow` | 入口 | 完整工作流编排（可按阶段裁剪） |
| `aws-case-design` | 1 | 需求分析 → 生成 Case 增量 YAML |
| `aws-case-reviewer` | 2 | Case 质量审查，输出 `case-review.json` |
| `aws-case-fixer` | 3 | 按 Review 建议自动修复 Case |
| `aws-api-plan` | 4 | API 测试规划（endpoint、断言、数据） |
| `aws-api-plan-reviewer` | 5 | API Plan 审查，输出 `api-plan-review.json` |
| `aws-api-plan-fixer` | 5 | 按 Review 建议修复 API Plan |
| `aws-api-codegen` | 7A | 根据 Plan 生成 pytest 测试代码 |
| `aws-e2e-plan` | 6 | E2E 测试规划（Python Playwright） |
| `aws-e2e-plan-reviewer` | 5 | E2E Plan 审查，输出 `plan-review.json` |
| `aws-e2e-plan-fixer` | 5 | 按 Review 建议修复 E2E Plan |
| `aws-e2e-codegen` | 7B | 根据 Plan 生成 Playwright 测试代码 |
| `aws-run` | 8/12 | 调用 `aws run` 执行测试并汇报 |
| `aws-inspect` | 9/13 | 调用 `aws report inspect` 并分类失败原因 |
| `aws-archive` | 末 | 归档 Case 增量 + 过程产物 |

### Healing Loop（自动修复循环）

| Skill | 阶段 | 说明 |
|---|:---:|---|
| `aws-fix-proposal` | 10 | 分析失败分类，生成结构化修复提案 `fix-proposal.json` |
| `aws-api-codegen-fixer` | 11A | 按提案修复 API 测试代码（含 Risk Gate，高风险需人工确认） |
| `aws-e2e-codegen-fixer` | 11B | 按提案修复 E2E 测试代码（含 Risk Gate，高风险需人工确认） |

### 工具

| Skill | 说明 |
|---|---|
| `aws-dashboard` | 打开 Case Center 可视化面板 |

---

## OpenCode 使用方式

在 OpenCode 中通过 Skill 触发完整工作流：

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

### 支持的执行模式

| 模式 | 说明 |
|---|---|
| `full` | 全流程：case 设计 → review → 规划 → review → codegen → 执行 |
| `case-only` | 仅 Case 设计 + Review |
| `plan-only` | 仅规划 + Review（依赖已有 Case）|
| `codegen-only` | 仅代码生成（依赖已有 Plan）|
| `review-case` | 仅 Case Review + Fix |
| `review-plan` | 仅 Plan Review + Fix |

### Skill 架构

所有 Skill 均通过 `skills/**/SKILL.md` 注册，OpenCode 在启动时自动扫描加载。不使用 `.opencode/agents` 文件或 `/aws-*` slash command。

**职责边界：**

- **Reviewer**：只读，输出结构化 JSON，永不修改 Case / Plan 文件
- **Fixer**：只处理 `auto_fix_allowed = true` 的 findings，不发明产品行为
- **Codegen Fixer**：只修改授权范围内的测试文件，高风险提案需人工确认
- **所有阶段均在 primary agent 内联执行**，不通过 subagent 加载 Skill

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
| `known_product_issue` | ✗ | 已知产品 bug，需产品修复 |
| `coverage_gap` | ✗ | 覆盖缺口，需产品修复 |
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
