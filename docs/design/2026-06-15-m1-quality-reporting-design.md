# M1 设计:Quality Reporting(Coverage + Report Generation)

> 状态:待评审
> 日期:2026-06-15
> 上游:[2026-06-15-vnext-quality-pipeline-trd.md](./2026-06-15-vnext-quality-pipeline-trd.md) §16 M1
> 总原则:不破坏现有 DAG / gate / DSL;CLI 是唯一可信执行/分类层;skill 只验证不伪造

---

## 1. 范围

M1 是 vNext 的第一个 Milestone,**不依赖任何新流程阶段(Target Classification / Fuzz)**,在现有 `aws-run` + `aws-inspect` 之上增量实现:

1. **Coverage 采集** — `aws-run` 执行 pytest 时附带 coverage,产出 `coverage-result.json`
2. **Coverage 门禁 + 解析** — `aws-inspect` 读取 coverage,产出 `quality-gate-result.json`
3. **Report Generation** — 新增 skill `aws-report-generator` + CLI `aws report generate`,产出研发可读质量报告
4. **Quality Score 确定性公式** — 在 CLI 层实现,LLM 不参与打分

**明确不做**:Fuzz、Target Classification、Code Quality 静态检查、Performance。

---

## 2. 现状锚点(代码事实)

| 组件 | 位置 | 现状 |
|------|------|------|
| pytest 执行 | `src/execution/pytest_runner.ts` | `runPytest()` 已传 `--junitxml`,可选 `--json-report`;无 coverage |
| 执行编排 | `src/execution/runner.ts` | `run()` 生成 batch_id,跑 pytest+playwright,写 `api-result.json`/`e2e-result.json`/`summary.md` |
| inspect | `src/report/inspector.ts` + `src/commands/report.ts` | `aws report inspect` 分类失败,写 `failure-analysis.json`/`failure-summary.md` |
| report 命令 | `src/commands/report.ts` | 现仅有 `report inspect` 子命令 |
| run skill | `skills/aws-run/SKILL.md` | 四态 `PASS/PASS_WITH_WARNINGS/FAIL/SKIPPED`;skill 验证 CLI 输出不伪造 |
| inspect skill | `skills/aws-inspect/SKILL.md` | 已有 `coverage_gap` 失败类别 + `coverage_gaps[]` 字段位 |

> 关键复用点:`aws-inspect` 的 `failure-analysis.json` 已预留 `coverage_gaps: []`,M1 把它接通到真实 coverage 数据。

---

## 3. 任务一:Coverage 采集(aws-run)

### 3.1 CLI 改动(`pytest_runner.ts`)

在 `runPytest()` 的 args 构造处(当前第 63-73 行)增加 coverage 参数:

```ts
const coverageJsonPath = path.join(rawDir, 'coverage.json');
const coverageXmlPath = path.join(rawDir, 'coverage.xml');

const args = [
  ...runner.baseArgs,
  ...effectiveTargets,
  `--junitxml=${xmlPath}`,
  // M1 新增:
  '--cov=app',                              // 覆盖率目标包(可配置,见 §3.3)
  `--cov-report=json:${coverageJsonPath}`,
  `--cov-report=xml:${coverageXmlPath}`,
  '--cov-report=term-missing',
];
```

> 前置:`--cov` 需要 `pytest-cov`。CLI 在加 args 前做能力探测(类似现有 `--json-report` 的 `helpCheck` 逻辑):若 `pytest --help` 不含 `cov`,跳过 coverage 参数并在结果里标 `coverage.available=false`,**不报错**(coverage 缺失是 warning 不是 fail)。

### 3.2 Coverage 结果归一(canonical schema)

新增 `src/execution/coverage_parser.ts`,把 `coverage.json`(coverage.py 原生格式)归一为 canonical:

```json
{
  "schema_version": "1.0",
  "change_id": "<change-id>",
  "batch_id": "<batch-id>",
  "kind": "coverage",
  "available": true,
  "line_coverage": 76.2,
  "branch_coverage": 64.8,
  "threshold": { "line": 70, "branch": 60 },
  "status": "PASS",
  "uncovered_critical_files": [
    { "file": "app/api/v1/menu.py", "line_coverage": 41.0 }
  ],
  "source": {
    "coverage_json": "execution/runs/<batch-id>/raw/coverage.json",
    "coverage_xml": "execution/runs/<batch-id>/raw/coverage.xml"
  }
}
```

写入路径(与现有 result 文件并列):

```
execution/runs/<batch-id>/coverage-result.json   ← per-run
execution/coverage-result.json                   ← latest 指针
```

`status` 判定规则(确定性):
- `line >= threshold.line && branch >= threshold.branch` → `PASS`
- 任一低于阈值 → `PASS_WITH_WARNINGS`(默认不阻断,见 §3.3)
- `available == false` → `SKIPPED`

### 3.3 配置(`.aws/config.yaml`)

```yaml
coverage:
  enabled: true
  target_package: app          # --cov=<target_package>
  threshold:
    line: 70
    branch: 60
  gate_mode: warn              # warn | block(默认 warn:低于阈值不阻断,仅 PASS_WITH_WARNINGS)
```

> `gate_mode: block` 时,低于阈值 → 最终 `FAIL`。默认 `warn`,符合 TRD §11「默认 PASS_WITH_WARNINGS,不阻断」。

### 3.4 skill 改动(`aws-run/SKILL.md`)

- **Output Files** 增加 `coverage-result.json`(per-run + latest 指针)
- **Final Status Mapping** 的 `PASS_WITH_WARNINGS` 增加一条:`coverage 低于阈值且 gate_mode == warn`
- **Hard Rules** 增加:coverage 缺失(无 pytest-cov)记 warning,**不得**因此 FAIL;skill 不伪造 coverage 数字
- `runPytest` 是 API 测试入口;**coverage 仅在 API pytest 运行时采集**(E2E playwright 不计入 M1 coverage)

---

## 4. 任务二:Coverage 解析 + Quality Gate(aws-inspect)

### 4.1 CLI 改动(`inspector.ts`)

`aws report inspect` 增量:
1. 读取 `execution/coverage-result.json`(若存在)
2. 把低覆盖文件填入 `failure-analysis.json` 已有的 `coverage_gaps[]`(不新建字段)
3. 新增产出 `quality-gate-result.json`(M1 的统一门禁结论)

### 4.2 `quality-gate-result.json`(新增,inspect 产出)

```json
{
  "schema_version": "1.0",
  "change_id": "<change-id>",
  "batch_id": "<batch-id>",
  "dimensions": {
    "functional": {
      "status": "PASS",
      "api": { "total": 36, "passed": 36, "failed": 0 },
      "e2e": { "total": 8, "passed": 8, "failed": 0 }
    },
    "coverage": {
      "status": "PASS_WITH_WARNINGS",
      "line_coverage": 76.2,
      "branch_coverage": 58.0,
      "threshold": { "line": 70, "branch": 60 }
    }
  },
  "final_status": "PASS_WITH_WARNINGS"
}
```

`final_status` 合成规则(确定性,worst-wins):
```
FAIL                 若任一维度 FAIL
PASS_WITH_WARNINGS   否则若任一维度 PASS_WITH_WARNINGS
PASS                 否则全 PASS
SKIPPED              若所有维度 SKIPPED
```

### 4.3 skill 改动(`aws-inspect/SKILL.md`)

- **Output Files** 增加 `inspect/quality-gate-result.json`
- **What the CLI Does** 增加「读取 coverage-result.json,合成 quality gate」
- **Status Update Rules** 不变(inspect 仍只能 PASS→PASS_WITH_WARNINGS,禁止任何→PASS)
- coverage 低于阈值映射到现有 `coverage_gap` 类别(已存在,`fix_proposal_eligible: false`)

> 复用现有 `coverage_gap` 类别意味着:**coverage 不达标不会进入 Heal 自动修复**,与 TRD §12 一致(coverage 不达标禁止自动变绿)。

---

## 5. 任务三:Report Generation(新增 skill + CLI)

### 5.1 新增 CLI 子命令 `aws report generate`

在 `src/commands/report.ts` 增加 `generate` 子命令(与 `inspect` 并列),新增 `src/report/report_generator.ts`。

```bash
aws report generate --change <change-id>
```

### 5.2 输入

```
execution/api-result.json
execution/e2e-result.json
execution/coverage-result.json
inspect/failure-analysis.json
inspect/quality-gate-result.json
qa/changes/<change-id>/known-product-issues.md
cases/**/case.yaml          ← 用于 Scope 章节(覆盖的 REQ)
```

### 5.3 Quality Score 确定性公式(CLI 实现,TRD §14)

```
Quality Score = Functional(60) + Coverage(25) + Fuzz(15)

  Functional(60) = 60 × (api_passed + e2e_passed) / (api_total + e2e_total)
  Coverage(25)   = 25 × min(line_coverage / threshold.line, 1.0)
  Fuzz(15)       = M1 无 fuzz → 该维度 N/A,按比例重分配到 Functional+Coverage
                   (M1 公式:Functional(70) + Coverage(30))
```

> M1 无 fuzz,采用退化公式 `Functional(70) + Coverage(30)`,并在报告中标注 Fuzz 维度为 `N/A (not in M1 scope)`。M3 引入 fuzz 后切回三维公式。Risk Level 由 LLM 判断但必须在报告写明依据。

### 5.4 输出

```
report/
├── quality-report.json     ← 结构化(CLI 写,确定性)
├── quality-report.md       ← 完整报告(CLI 写)
└── executive-summary.md    ← 一页纸结论(CLI 写)
```

`quality-report.json` 结构:

```json
{
  "schema_version": "1.0",
  "change_id": "<change-id>",
  "batch_id": "<batch-id>",
  "final_status": "PASS_WITH_WARNINGS",
  "quality_score": 87,
  "score_breakdown": {
    "functional": 70.0,
    "coverage": 17.0,
    "fuzz": "N/A"
  },
  "scope": { "cases": 12, "requirements": ["REQ-101", "REQ-102"] },
  "functional": { "api": {}, "e2e": {} },
  "coverage": {},
  "defects": { "product": [], "test": [], "environment": [] },
  "risk_level": "LOW",
  "risk_rationale": "全部功能用例通过,仅分支覆盖略低于阈值,无产品缺陷",
  "recommendation": "可以上线但需关注分支覆盖"
}
```

### 5.5 新增 skill `aws-report-generator/SKILL.md`

契约对齐现有 run/inspect skill 风格:

- **Context Contract**:先读 `workflow-state.yaml`,要求 `phases.inspect.status == done`(必须先 inspect)
- **Skill vs CLI Boundary**:CLI(`aws report generate`)是唯一可信生成层,产出 quality_score / 结构化报告;skill 验证文件存在,**不伪造分数或结论**
- **AWS CLI Identity Check**:同 run/inspect,先 `aws --version` 确认是 Assurance Workflow Skills CLI
- **risk_level / recommendation 边界**:CLI 给确定性 quality_score;risk_level 与 recommendation 的最终措辞可由 LLM 基于 CLI 数据润色,但**不得**改变 final_status,也不得在有 product defect 时写"可以上线"
- **Output Files**:`report/quality-report.json` / `quality-report.md` / `executive-summary.md`
- **workflow-state 更新**:`phases.report.status = done`,`phases.report.quality_score = <int>`
- **Hard Rules**:
  - 不得在 `final_status == FAIL` 时输出"建议上线"
  - 不得在存在未解决 product defect 时输出"可以上线"(最多"建议上线但需关注")
  - quality_score 来自 CLI,skill 不重算、不修改

---

## 6. aws-workflow 编排接入

在 `aws-workflow/SKILL.md` 现有 phase 序列后增加 **Report Generation phase**:

```
... → Run → Inspect → Heal → Report Generation(新增终态)
```

- Report 阶段前置:`phases.inspect.status == done`(healing 收敛后)
- Report 是**终态产出**,不参与 gate 决策(gate 已由 inspect 的 quality-gate-result.json 决定)
- workflow 最终摘要引用 `report/executive-summary.md`

> 迁移安全:Report phase 是**追加**,不改动现有 Run/Inspect/Heal 的任何契约。旧 change 无 report 阶段不受影响。

---

## 7. 交付物清单

### CLI(`src/`)

| 文件 | 改动 |
|------|------|
| `src/execution/pytest_runner.ts` | 加 coverage 参数 + 能力探测 |
| `src/execution/coverage_parser.ts` | **新增**:coverage.json → canonical |
| `src/execution/runner.ts` | 写 coverage-result.json(per-run + latest) |
| `src/report/inspector.ts` | 读 coverage,写 quality-gate-result.json |
| `src/report/report_generator.ts` | **新增**:质量报告 + quality_score |
| `src/commands/report.ts` | 加 `generate` 子命令 |
| `src/core/types.ts` | 加 CoverageResult / QualityGateResult / QualityReport 类型 |

### Skills(`skills/`)

| 文件 | 改动 |
|------|------|
| `skills/aws-run/SKILL.md` | coverage 输出 + 状态映射 + hard rule |
| `skills/aws-inspect/SKILL.md` | coverage 解析 + quality-gate-result.json |
| `skills/aws-report-generator/SKILL.md` | **新增 skill** |
| `skills/aws-workflow/SKILL.md` | 追加 Report Generation phase |

### 配置 / 测试

| 文件 | 改动 |
|------|------|
| `.aws/config.yaml` 模板 | 加 `coverage` 配置块 |
| `src/templates/` | 同步 config 模板默认值 |
| `tests/integration/` | coverage 采集 + report 生成集成测试 |

---

## 8. 实施顺序(建议)

```
Step 1  types.ts 加类型(CoverageResult / QualityGateResult / QualityReport)
Step 2  pytest_runner.ts + coverage_parser.ts:采集 coverage,跑通 coverage-result.json
Step 3  runner.ts 写 coverage 指针文件;aws-run skill 同步
Step 4  inspector.ts 合成 quality-gate-result.json;aws-inspect skill 同步
Step 5  report_generator.ts + report.ts generate 子命令(含 quality_score 公式)
Step 6  aws-report-generator skill 编写
Step 7  aws-workflow 追加 Report phase
Step 8  集成测试 + config 模板
```

> Step 2-4 可独立验证(跑一次真实 change 看 coverage-result.json);Step 5-7 依赖前序但彼此线性。适合 subagent-driven 分任务。

---

## 9. 开放项(承接 TRD §17)

| 编号 | 开放项 | M1 内决议 |
|------|--------|-----------|
| O3 | Coverage threshold 默认值与配置方式 | 已定:`.aws/config.yaml coverage.threshold`,默认 line 70 / branch 60 |
| O4 | Risk Level 的 LLM prompt 与依据格式 | 已定:CLI 出 quality_score(确定性),risk_level 由 skill 层 LLM 基于 quality-report.json 判定并写 rationale,不改 final_status |
| 新 | E2E 是否计入 coverage | M1 决议:**否**,仅 API pytest 采集 coverage(playwright E2E 不计) |
| 新 | coverage gate_mode 默认 | M1 决议:`warn`(不阻断,PASS_WITH_WARNINGS) |
```
