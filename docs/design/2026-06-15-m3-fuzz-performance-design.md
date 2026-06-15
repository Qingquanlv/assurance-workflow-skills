# M3 设计:Fuzz + Performance Flow

> 状态:待评审
> 日期:2026-06-15
> 上游:[2026-06-15-vnext-quality-pipeline-trd.md](./2026-06-15-vnext-quality-pipeline-trd.md) §16 M3
> 前置:M1(Quality Reporting)已落地(quality-gate-result.json / aws-report-generator 存在)
> 总原则:不破坏现有 DAG / gate / DSL;每类测试 plan 必须经 review gate 才能 codegen;Heal 禁止变绿

---

## 1. 范围

M3 把测试目标从 API/E2E 两类扩展到四类,新增 **Fuzz**(schemathesis)与 **Performance**(Locust,绝对阈值无基线):

1. **四层测试选型** — `aws-case-design` 决策树扩展 + `aws-case-reviewer` 选型校验
2. **Fuzz Flow** — plan → review → codegen → run,复用 pytest 基础设施
3. **Performance Flow** — plan → review → codegen → run,新增 Locust runner
4. **Quality Gate / Report 接入** — Fuzz/Performance 结果纳入 quality-gate-result.json + 四维 Quality Score

**明确不做**:性能基线持久化与历史对比(仅绝对阈值)、Security、Code Quality 静态检查。

---

## 2. 关键技术洞察(决定工作量分布)

| 测试类型 | 执行底座 | CLI 改动 | 工作量 |
|----------|----------|----------|--------|
| **Fuzz** | schemathesis 的 **pytest 集成**(`schema.parametrize()`)→ 生成的是 pytest 文件 | **复用** `pytest_runner.ts`,只加 `tests/fuzz/` target 发现 | **低** |
| **Performance** | Locust headless,**非 pytest** | **新增** `locust_runner.ts` + 新 result adapter | **中** |

> Fuzz 的 codegen 产物是 `tests/fuzz/test_*.py`(用 schemathesis 装饰器),走的还是 pytest + JUnit XML,因此 `fuzz-result.json` 可复用 API 的 pytest adapter。Performance 是 Locust 独立进程,产物是统计指标,必须新建 runner 和 adapter。

这条洞察让 M3 的真实重心落在 **Performance runner + 四层选型**,Fuzz 主要是 skill 编写。

---

## 3. 现状锚点(代码事实)

| 组件 | 位置 | 复用方式 |
|------|------|----------|
| pytest 执行 | `src/execution/pytest_runner.ts` | Fuzz 直接复用(换 target 目录) |
| E2E 执行 | `src/execution/playwright_runner.ts` | Performance runner 镜像其 spawnSync + 产物拷贝结构 |
| 执行编排 | `src/execution/runner.ts` | 加 fuzz/perf target 发现 + 写 result |
| 结果解析 | `src/execution/result_parser.ts` | Fuzz 复用 `parsePytestXml`;Performance 新增 parser |
| inspect | `src/report/inspector.ts` | 读 fuzz/perf result,纳入 quality-gate |
| plan 三件套 | `aws-api-plan` / `*-reviewer` / `aws-api-codegen` | 镜像为 fuzz/perf 对应 skill |
| 选型决策树 | `aws-case-design` L118-134 | 两层扩四层 |
| 分层校验 | `aws-case-reviewer` §13 Layering Review | 扩展校验 fuzz/perf 选型 |

---

## 4. 任务一:四层测试选型(aws-case-design + aws-case-reviewer)

### 4.1 `aws-case-design` 决策树扩展

现有 `Test Layer Decision Tree`(L118-134)两层扩为四层:

```
Behavior to verify:
├─ 单 HTTP 请求 + 响应断言            → API         (tests/api/)
├─ 多步浏览器交互 + UI 反馈           → E2E         (tests/e2e/)
├─ 复杂输入 / Schema / 边界 / Parser  → Fuzz        (tests/fuzz/)
└─ 高频 / 核心 / 复杂查询 / 关键能力   → Performance (qa/perf/)
```

新增 Hard rules:
- Fuzz 仅用于**输入鲁棒性**(schema/边界),不替代功能断言;每个 fuzz 目标必须有对应 API case 做功能验证
- Performance 仅用于**高频/核心**能力,不滥用;必须在 case 里写明绝对阈值(见 §4.3)
- Fuzz/Performance 是**附加**目标,不取消该 case 的 API/E2E 功能覆盖

### 4.2 选型对话(复用既有 HARD-GATE)

无需新增确认点。在 `aws-case-design` Checklist 第 6 步「propose 2-3 approaches」中,LLM 一并提议 fuzz/perf 选型;第 7 步用户确认时一并确认。沿用现有 HARD-GATE。

### 4.3 `automation` schema 扩展(case.yaml)

```yaml
automation:
  required: true
  target: API | E2E | Fuzz | Performance | Mixed
  fuzz:                          # 当 target 含 Fuzz
    required: true
    reason: "包含用户输入 schema,存在边界风险"
    endpoints: ["/api/v1/menu/create"]    # fuzz 目标端点
  performance:                   # 当 target 含 Performance
    required: true
    reason: "高频核心查询接口"
    scenarios:
      - capability: "menu-list-query"
        endpoint: "/api/v1/menu/list"
        thresholds: { p95_ms: 200, error_rate_max: 0.01 }
        load: { users: 50, spawn_rate: 10, run_time_s: 60 }
  confirmed_by: user
  confirmed_at: "2026-06-15T08:00:00Z"
```

> 阈值是**绝对值**,用户选型时确认,无历史基线。

### 4.4 `aws-case-reviewer` 选型校验(扩展 §13 Layering Review)

§13 现有 Type 1/Type 2 分类基础上,新增 fuzz/perf 反模式:

| 反模式 | 分类 | 处理 |
|--------|------|------|
| 用 Fuzz 替代功能断言(无对应 API case) | Type 2 | `human_review_required`,退回 case-design |
| Fuzz 标在无用户输入的纯读接口 | Type 1 | `auto_fix_allowed: true`, `fix_scope: ["automation.fuzz"]` |
| Performance 标在低频/非核心接口 | Type 1 | 同上,`fix_scope: ["automation.performance"]` |
| Performance 缺 thresholds | Type 2 | blocker,必须补阈值 |
| 同一断言点在 API 和 Fuzz 重复 | Type 2 | 断言迁移 |

> 复用现有 `fix_scope` 机制(reviewer 限定 fixer 动作范围),与 C1 分层修复规则一致。

---

## 5. 任务二:Fuzz Flow(复用 pytest)

### 5.1 `aws-fuzz-plan`(新 skill,镜像 aws-api-plan)

- **Context Contract**:前置 `phases.case_review.status == pass`;读 `cases/**/case.yaml` 筛 `automation.target` 含 Fuzz 的 case
- **产物**:
  - `plans/fuzz-plan.md` — 每个 fuzz 目标端点 + schema 来源 + 期望(无 5xx、符合 schema 的输入不报 400)
  - `plans/fuzz-codegen-plan.md` — Target Files 映射(`tests/fuzz/test_<module>_fuzz.py`)
  - `plans/fuzz-review-summary.md`
- **不生成代码**

### 5.2 `aws-fuzz-plan-reviewer`(新 skill,镜像 aws-api-plan-reviewer)

产出 `review/fuzz-plan-review.json`,gate 字段同 api-plan-review(`decision==pass` / `codegen_readiness` / `blockers` 空)。

### 5.3 `aws-fuzz-codegen`(新 skill,镜像 aws-api-codegen)

- **Gate**:`review/fuzz-plan-review.json` decision==pass
- **产物**:`tests/fuzz/test_<module>_fuzz.py`,使用 schemathesis pytest 集成:

```python
import schemathesis

schema = schemathesis.from_asgi("/openapi.json", app)

@schema.parametrize(endpoint="/api/v1/menu/create")
def test_menu_create_fuzz(case):
    response = case.call_asgi()
    case.validate_response(response)   # 自动断言:无 5xx、响应符合 schema
```

- 继承 C5 规则(Test Failure Integrity):不得 `xfail`/`skip` 让 fuzz 变绿

### 5.4 CLI 执行(复用 pytest_runner)

`runner.ts` 的 `discoverTargets` 增加 fuzz:

```ts
const fuzzTargets = discoverTargets(changesBase, 'fuzz-codegen-plan.md', projectRoot, ['tests/fuzz']);
const fuzzResult = runPytest({ changeId, batchId, targets: fuzzTargets, batchDir, cwd: projectRoot });
```

> Fuzz 走 pytest,产 JUnit XML,**复用 `parsePytestXml`**。归一时 `kind: "fuzz"`。写 `fuzz-result.json`(per-run + latest)。

### 5.5 Fuzz 失败分类(aws-inspect 扩展)

新增类别(对接 TRD §12):

```
configuration-error   (auth/schema 配置错误)    → fix_proposal_eligible: true  (允许 Heal)
stateful-test-failure (产品 5xx / schema 违约)   → fix_proposal_eligible: false (产品 bug,禁止 Heal)
```

---

## 6. 任务三:Performance Flow(新增 Locust runner)

### 6.1 `aws-performance-plan`(新 skill)

- 前置 `phases.case_review.status == pass`;读含 Performance 的 case
- **产物**:
  - `plans/performance-plan.md` — 每个 scenario 的 endpoint / 负载档位 / **绝对阈值**
  - `plans/performance-codegen-plan.md` — Locust 文件映射(`qa/perf/<capability>_locustfile.py`)
  - `plans/performance-review-summary.md`

### 6.2 `aws-performance-plan-reviewer`(新 skill)

产出 `review/performance-plan-review.json`。额外校验:
- 每个 scenario 有完整 thresholds(p95_ms / error_rate_max)
- 负载档位合理(users/run_time 非 0)
- 阈值非占位符

### 6.3 `aws-performance-codegen`(新 skill)

- Gate:`review/performance-plan-review.json` decision==pass
- **产物**:`qa/perf/<capability>_locustfile.py`:

```python
from locust import HttpUser, task, between

class MenuListUser(HttpUser):
    wait_time = between(0.1, 0.5)

    @task
    def list_menus(self):
        self.client.get("/api/v1/menu/list?page=1&page_size=20",
                        headers={"token": self.environment.parsed_options.token})
```

- C5 规则:不得为了达标而构造空请求/假负载

### 6.4 CLI 执行(新增 `locust_runner.ts`,镜像 playwright_runner)

```ts
// src/execution/locust_runner.ts
export function runLocust(opts: LocustRunOptions): LocustRunResult {
  // 1. 读 performance-codegen-plan.md / case scenarios 取 host + 阈值 + 负载档位
  // 2. 环境前置检查:host 可达性(GET /;不可达 → SKIPPED,不误报 FAIL)见 O5
  // 3. spawnSync:
  //    locust -f <file> --headless -u <users> -r <spawn_rate>
  //           --run-time <run_time_s>s --host <host> --json
  // 4. 解析 stdout JSON(locust 2.x)/ --csv 文件,取 p95 / error_rate / rps
  // 5. 对每个 scenario:measured vs thresholds → verdict PASS/FAIL
  // 6. 归一为 canonical performance-result.json(见 TRD §9 示例)
}
```

判定规则(绝对阈值,确定性):
- `p95_ms <= threshold.p95_ms && error_rate <= threshold.error_rate_max` → scenario PASS
- 任一超阈值 → scenario FAIL(真实性能问题)
- host 不可达 / 服务未起 → scenario SKIPPED(环境问题,不算 FAIL)

`runner.ts` 增加:

```ts
const perfResult = runLocust({ changeId, batchId, scenarios, batchDir, cwd: projectRoot });
fs.writeFileSync(path.join(batchDir, 'performance-result.json'), JSON.stringify(perfResult.result, null, 2));
// + latest 指针
```

### 6.5 Performance 失败分类(aws-inspect 扩展)

```
perf-script-error       (脚本/endpoint/请求构造错)  → fix_proposal_eligible: true  (允许 Heal)
perf-threshold-exceeded (实测超绝对阈值)            → fix_proposal_eligible: false (禁止 Heal,禁止改阈值变绿)
perf-environment        (host 不可达 / 服务未起)     → SKIPPED,不进 Fix Proposal
```

---

## 7. 任务四:Quality Gate + Report 接入

### 7.1 `aws-run` skill 改动

- Output Files 增加 `fuzz-result.json` / `performance-result.json`(per-run + latest)
- `selected_targets` 扩展:`fuzz` / `performance`(由 case 的 automation.target 解析)
- Final Status Mapping:perf-threshold-exceeded / fuzz stateful-failure → FAIL

### 7.2 `aws-inspect` skill 改动(扩展 M1 的 quality-gate-result.json)

```json
{
  "dimensions": {
    "functional": { "status": "PASS", "api": {}, "e2e": {}, "fuzz": {} },
    "non_functional": {
      "status": "PASS",
      "performance": [
        { "capability": "menu-list-query", "measured_p95_ms": 145, "threshold_p95_ms": 200, "verdict": "PASS" }
      ]
    },
    "coverage": { "status": "PASS_WITH_WARNINGS" }
  },
  "final_status": "PASS_WITH_WARNINGS"
}
```

`final_status` 仍 worst-wins(M1 已定),新增 non_functional 维度参与。

### 7.3 `aws-report-generator` skill 改动

- Quality Score 从 M1 退化版切到 TRD §14 全量四维:`Functional(50)+Coverage(20)+Fuzz(15)+Performance(15)`
- 报告增加 **Non-Functional Quality** 章节:各 scenario 实测值 vs 阈值表

---

## 8. 交付物清单

### Skills(`skills/`)

| Skill | 类型 |
|-------|------|
| `aws-case-design` | 改动:决策树四层 + automation schema |
| `aws-case-reviewer` | 改动:§13 选型校验扩展 |
| `aws-fuzz-plan` | 新增 |
| `aws-fuzz-plan-reviewer` | 新增 |
| `aws-fuzz-codegen` | 新增 |
| `aws-performance-plan` | 新增 |
| `aws-performance-plan-reviewer` | 新增 |
| `aws-performance-codegen` | 新增 |
| `aws-run` | 改动:fuzz/perf 执行 + selected_targets |
| `aws-inspect` | 改动:fuzz/perf 失败分类 + quality-gate 维度 |
| `aws-report-generator` | 改动:四维 Score + Non-Functional 章节 |
| `aws-workflow` | 改动:phase 序列加 fuzz/perf 分支 |

> Fixer skill(`aws-fuzz-codegen-fixer` / `aws-performance-codegen-fixer`):见 §10 开放项 O7——是否需要独立 fixer 待定。

### CLI(`src/`)

| 文件 | 改动 |
|------|------|
| `src/execution/runner.ts` | fuzz/perf target 发现 + 写 result |
| `src/execution/locust_runner.ts` | **新增**:Locust 执行 + 阈值判定 |
| `src/execution/result_parser.ts` | 新增 Locust stats parser;fuzz 复用 pytest parser |
| `src/report/inspector.ts` | fuzz/perf 失败分类 + quality-gate 维度合成 |
| `src/report/report_generator.ts` | 四维 Quality Score |
| `src/core/types.ts` | FuzzResult(复用 ApiResult 形态) / PerformanceResult 类型 |
| `src/commands/run.ts` | 透传 fuzz/perf 选项(若需要) |

### 配置 / 测试

| 文件 | 改动 |
|------|------|
| `.aws/config.yaml` 模板 | 加 fuzz / performance 开关与默认负载档位 |
| 依赖 | `schemathesis`、`locust`(项目 dev 依赖) |
| `tests/integration/` | fuzz 复用 pytest 的集成测试;locust runner 集成测试 |

---

## 9. 实施顺序(建议,适合 subagent-driven)

```
Phase A — 选型(基础,其它都依赖)
  A1  aws-case-design 决策树四层 + automation schema
  A2  aws-case-reviewer §13 选型校验扩展

Phase B — Fuzz(复用 pytest,先做,验证 plan→review→codegen→run 链路)
  B1  aws-fuzz-plan / aws-fuzz-plan-reviewer / aws-fuzz-codegen
  B2  runner.ts 加 fuzz target;复用 pytest parser 写 fuzz-result.json
  B3  aws-inspect fuzz 失败分类

Phase C — Performance(新 runner,最重)
  C1  aws-performance-plan / *-reviewer / aws-performance-codegen
  C2  locust_runner.ts + Locust stats parser + 阈值判定
  C3  runner.ts 加 perf 执行;写 performance-result.json
  C4  aws-inspect perf 失败分类 + 环境 SKIPPED

Phase D — 汇总接入
  D1  quality-gate-result.json 加 fuzz/non_functional 维度
  D2  aws-report-generator 切四维 Score + Non-Functional 章节
  D3  aws-workflow phase 序列接入 fuzz/perf 分支
  D4  集成测试 + config 模板 + 依赖声明
```

> Phase B 可先独立交付验证(Fuzz 闭环),再做 Phase C(Performance)。两者通过 Phase A 的选型共享入口,但 codegen/run 互相独立。

---

## 10. 开放项

| 编号 | 开放项 | 决议 / 待定 |
|------|--------|-------------|
| O1 | canonical adapter 具体映射 | Fuzz=复用 pytest adapter;Performance=新 Locust stats adapter(stdout JSON / CSV 二选一,C2 定) |
| O5 | Locust 环境前置 / SKIPPED 判定 | host 不可达 → scenario SKIPPED,不误报 FAIL;runner 启动前做可达性探测 |
| O6 | Performance 阈值默认值 | 用户未指定时**不给默认**,reviewer 标 blocker 要求补(阈值必须人工确认,避免假绿) |
| O7 | 是否需要独立 fuzz/perf fixer skill | 倾向**复用**现有 fixer 模式或仅 Heal 可修类;Performance 实测超阈值不可 fix,fixer 价值有限——建议 M3 先不建独立 fixer,Heal 仅处理 script-error 类 |
| O8 | fuzz/perf 是否需要 plan-review gate | **需要**(AWS 核心原则:plan 必经 review 才 codegen)。本设计给了独立 reviewer;若嫌 skill 多,可后续合并为共享 reviewer,但 M3 先保持对称清晰 |
| O9 | schemathesis ASGI vs URL 模式 | 倾向 `from_asgi`(进程内,无需起服务);若项目结构不便,回退 `from_uri` 跑 live 服务 |

---

## 11. 与 M1 的衔接

M3 不改动 M1 已交付的契约,只**扩展**:
- `quality-gate-result.json`:M1 的 functional/coverage 维度不变,新增 non_functional 维度 + functional.fuzz 子项
- Quality Score:M1 退化公式 → M3 全量四维(report_generator 内切换,按已落地维度)
- `aws-report-generator`:M1 报告结构不变,新增 Non-Functional 章节

> 若 M3 某 change 不含 fuzz/perf 目标,流程与 M1 完全一致(fuzz/perf 维度标 N/A / SKIPPED)。
```
