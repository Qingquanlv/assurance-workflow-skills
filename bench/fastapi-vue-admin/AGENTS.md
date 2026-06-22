# AGENTS.md — vue-fastapi-admin

## 项目简介

基于 Vue3 + FastAPI 的后台管理系统，包含用户管理、角色管理、权限管理等核心模块。

- 前端：`web/`（Vue3 + Vite + Naive UI）
- 后端：`app/`（FastAPI + Tortoise ORM）
- E2E 测试：`tests/e2e/`（Playwright + pytest）
- QA 产物：`qa/changes/<change-id>/`

---

## 项目本地 Skills

Skills 由 opencode.json 从 `assurance-workflow-skills/skills/` 目录加载，无需本地副本。遇到对应触发词或任务时，**必须**先用 Read 工具读取对应 `SKILL.md` 全文，再按其中指令执行。

> 全流程主编排入口：`/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-workflow/SKILL.md`（触发词：`/qa`、`qa workflow`、`start qa`）

### Phase 1 — Case Design

| 触发词 / 命令 | Skill 路径 | 说明 |
|---|---|---|
| `/brainstorming-for-qa`、QA 需求梳理、生成 case delta | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-case-design/SKILL.md` | QA 范围问答 → 写 proposal.md + case-delta.yaml |
| `aws review case`、review generated case、check case quality | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-case-reviewer/SKILL.md` | 结构化 review Case 产物，输出 case-review.json（只读）|
| `apply case review`、fix case findings、auto fix case delta | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-case-fixer/SKILL.md` | 应用 case-review.json 中可自动修复的 findings |

### Phase 2 — Test Planning

| 触发词 / 命令 | Skill 路径 | 说明 |
|---|---|---|
| `/api-planning-for-qa`、generate API plan | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-api-plan/SKILL.md` | 生成 API 测试计划（api-codegen-plan.md）|
| `/e2e-planning-for-qa`、generate E2E plan | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-e2e-plan/SKILL.md` | 生成 E2E 测试计划（e2e-codegen-plan.md）|
| `generate fuzz plan`、fuzz planning | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-fuzz-plan/SKILL.md` | 生成 Fuzz 测试计划（fuzz-codegen-plan.md），基于 schemathesis |
| `generate performance plan`、perf planning | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-performance-plan/SKILL.md` | 生成 Performance 测试计划（performance-codegen-plan.md），基于 Locust 绝对阈值 |
| `aws review plan`、review api-plan、check plan quality | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-api-plan-reviewer/SKILL.md` | 结构化 review API Plan，输出 plan-review.json（只读）|
| `aws review e2e plan`、review e2e-plan | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-e2e-plan-reviewer/SKILL.md` | 结构化 review E2E Plan，输出 plan-review.json（只读）|
| `aws review fuzz plan` | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-fuzz-plan-reviewer/SKILL.md` | 结构化 review Fuzz Plan（只读）|
| `aws review performance plan` | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-performance-plan-reviewer/SKILL.md` | 结构化 review Performance Plan（只读）|
| `apply plan review`、fix plan findings | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-api-plan-fixer/SKILL.md` | 应用 API plan-review.json 中可自动修复的 findings |
| `apply e2e plan review` | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-e2e-plan-fixer/SKILL.md` | 应用 E2E plan-review.json 中可自动修复的 findings |

### Phase 3 — Test Code Generation

| 触发词 / 命令 | Skill 路径 | 说明 |
|---|---|---|
| `/api-codegen-for-qa`、generate API test code | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-api-codegen/SKILL.md` | 生成 pytest API 测试代码（必须先完成 planning）|
| `/e2e-codegen-for-qa`、generate E2E test code | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-e2e-codegen/SKILL.md` | 生成 Playwright E2E 测试代码（必须先完成 planning）|
| `generate fuzz tests`、fuzz codegen | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-fuzz-codegen/SKILL.md` | 生成 schemathesis Fuzz 测试（必须先完成 fuzz planning）|
| `generate performance tests`、locust codegen | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-performance-codegen/SKILL.md` | 生成 Locust 性能测试文件到 `qa/perf/`（必须先完成 performance planning）|
| `fix api codegen` | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-api-codegen-fixer/SKILL.md` | 修复 API 测试代码生成问题 |
| `fix e2e codegen` | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-e2e-codegen-fixer/SKILL.md` | 修复 E2E 测试代码生成问题 |

### Phase 4 — Execution & Reporting (M1/M3)

| 触发词 / 命令 | Skill 路径 | 说明 |
|---|---|---|
| `aws run`、run tests、执行测试、verify change | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-run/SKILL.md` | 调用 `aws run --change <id>` 执行 API/E2E/Fuzz/Performance，写 execution-manifest.yaml + 各 result.json + summary.md |
| `aws inspect`、inspect failures、classify failures | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-inspect/SKILL.md` | 调用 `aws report inspect --change <id>`，基于 execution-manifest 分类失败，写 failure-analysis.json |
| `aws report generate`、generate quality report | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-report-generator/SKILL.md` | 调用 `aws report generate --change <id>`，生成 quality-report.json + executive-summary.md |
| `fix proposal`、generate fix | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-fix-proposal/SKILL.md` | 为 fix_proposal_eligible 的失败生成修复建议 |

### 辅助 Skills

| 触发词 / 命令 | Skill 路径 | 说明 |
|---|---|---|
| `/qa-dashboard`、查看 case、Case Center、展示用例 | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-dashboard/SKILL.md` | 启动浏览器可视化 Case Center |
| `qa archive`、归档 QA、merge case delta | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/aws-archive/SKILL.md` | 归档 case delta 到 qa/cases/，清理过程产物 |
| 创建 skill、编写 SKILL.md、writing skills | `/Users/lvqingquan/skills/assurance-workflow-skills/skills/writing-skills/SKILL.md` | 新建或修改 skill 的规范与 TDD 流程 |

---

## QA 目录约定

```
qa/
  cases/                          # 归档的稳定 case（aws-archive 写入）
  changes/
    <change-id>/
      workflow-state.yaml          # 变更元数据 + 工作流状态 + selected_targets
      proposal.md                  # QA 范围说明文档
      cases/<module>/case.yaml     # Case Delta（增量 case 定义）
      plans/                       # 测试计划文件
        api-codegen-plan.md
        e2e-codegen-plan.md
        fuzz-codegen-plan.md       # M3 Fuzz
        performance-codegen-plan.md # M3 Performance
      review/                      # Review 结果（case-review.json、plan-review.json）
      inspect/                     # Inspect 结果
        failure-analysis.json
        failure-summary.md
        quality-gate-result.json
      execution/
        execution-manifest.yaml    # 本次执行的 batch_id + selected_targets + result_files 索引
        summary.md                 # latest 指针
        api-result.json            # latest 指针（api selected 时）
        e2e-result.json            # latest 指针（e2e selected 时）
        coverage-result.json       # 始终写出（api=false 时 status=SKIPPED）
        fuzz-result.json           # latest 指针（fuzz selected 时）
        performance-result.json    # latest 指针（performance selected 时）
        quality-gate-result.json   # latest 指针
        runs/
          <batch-id>/              # 审计存档，永不覆盖
            api-result.json
            e2e-result.json
            coverage-result.json
            fuzz-result.json
            performance-result.json
            quality-gate-result.json
            summary.md
            execution-manifest.yaml
            raw/                   # 原始日志、CSV
  perf/                            # Locust 文件（M3）
    locustfile_<module>.py
```

## 测试执行

```bash
# 启动后端
python run.py

# 启动前端
cd web && pnpm dev

# 运行 E2E 测试（headed 模式，直接调用）
uv run pytest tests/e2e/ -v --headed

# ── AWS CLI 质量流水线（推荐） ──────────────────────────────────────────

# 执行所有选中 target（API + E2E + Fuzz + Performance），写 execution-manifest.yaml
aws run --change <change-id>

# 查看执行结果摘要（分类失败，输出 failure-analysis.json）
aws report inspect --change <change-id>

# 生成质量报告（Quality Score + executive-summary.md）
aws report generate --change <change-id>
```
