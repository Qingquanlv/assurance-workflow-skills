# AWS Workflow vNext:Case-Driven Quality Pipeline TRD(修订版 v2)

> 状态:方向已定,待拆分 Milestone 设计
> 日期:2026-06-15
> 修订:基于 [aws-vnext-trd-review] 三项决议 + v2 两项调整
> 总原则:不破坏现有 DAG / gate / DSL 架构;Case 驱动;质量门禁决定终态

---

## 0. 修订摘要

### v1 相对初版(三项)

| 编号 | 初版问题 | 决议 |
|------|----------|------|
| B1 | Target Classification 由 LLM 黑盒决策,非确定性 | **改为人机协作选型**:LLM 提议 + 用户确认,确认结果不可被后续阶段覆盖 |
| B2 | Ruff / MyPy / Bandit 静态检查混入 Case 流程 | **删除**。静态检查归 CI 门禁,不进 aws-workflow。Quality Gate 仅保留 Coverage |
| B3 | MVP 一次交付 6 项功能,风险过高 | **分期**为 M1 / M3,每期可独立发布、独立验证 |

### v2 调整(两项)

| 编号 | 调整 | 说明 |
|------|------|------|
| V1 | **Target Classification 并入 `aws-case-design`,不单独建 skill** | `aws-case-design` 已负责 automation targets 的协作对话(已有决策树 + 2-3 方案 + 用户确认),Target Classification 本质是把两层决策树(API/E2E)扩展为四层(+Fuzz/+Performance)。删除 `aws-target-classifier` skill。选型校验由 `aws-case-reviewer` 承担 |
| V2 | **新增 Performance(简单模式,无基线)** | 基于 Locust 的性能测试,**不做基线持久化与历史对比**。采用 plan 中定义的**绝对阈值**(如 P95 < 200ms、error_rate < 1%),无状态,结构与 Fuzz 对称 |

保留初版全部设计亮点:Case 是唯一入口、Coverage 是 Gate 不是 Case、Heal 禁止变绿列表、Report 作为独立终态 phase。

---

## 1. 背景

当前 AWS Workflow 已实现完整的测试流水线:

```
Case → Case Review → API/E2E Plan → Plan Review → Codegen → Run → Inspect → Heal
```

具备:Case 资产沉淀、API/E2E 测试生成、自动执行、自动分析、自动修复。

但当前体系仍属于 **Test Pipeline**,只关注 API Test 与 E2E Test,缺少:

- Coverage 质量门禁
- Fuzz Testing
- Performance(简单性能测试,绝对阈值)
- 统一的质量结论输出(上线建议 / 风险分析)

---

## 2. 目标

将 AWS Workflow 升级为 **Case-Driven Quality Pipeline(用例驱动质量流水线)**。

核心流程保持不变:

```
Case → Plan → Codegen → Run → Inspect → Heal
```

扩展支持:

```
Functional Quality(API / E2E / Fuzz)
Non-Functional Quality(Performance,绝对阈值)
Coverage Quality
Release Quality(质量报告 + 上线建议 + 风险分析)
```

**明确不做**(归 CI 或后续阶段):Code Quality 静态检查(Ruff/MyPy/Bandit)、**性能基线持久化与历史对比**、Security Scan、Accessibility、Compliance。

---

## 3. 设计原则

### Principle 1 — Case 是唯一入口

所有质量活动必须由 Case 驱动。禁止直接生成测试 / 直接生成性能脚本 / 直接执行扫描。

```
Case(含测试选型)→ Plan → Codegen → Run
```

### Principle 2 — Coverage 不是 Case,是 Quality Gate

禁止把 coverage 写成测试目标。Coverage 仅在 Quality Gate 阶段参与判定,不进入 Case / 选型 / Plan。

### Principle 3 — 质量门禁决定最终状态

最终状态由 Functional Result(API/E2E/Fuzz)+ Non-Functional Result(Performance)+ Coverage Result 共同决定。各 Milestone 按已落地维度合成。

### Principle 4 — 测试选型是人机协作,不是黑盒

测试选型(深度 / 广度 / 工具:API / E2E / Fuzz / Performance)由 LLM **提议**、用户**确认**。

**该选型动作并入 `aws-case-design`**(不单独建阶段):`aws-case-design` 已有「propose 2-3 approaches → 等用户 explicit 确认」的协作模式与决策树,本设计将其决策树从两层扩展为四层。用户确认后写入 case 的 `automation` 字段,在后续 Plan / Codegen / Run 阶段**只读、不可覆盖**。

---

## 4. 流程对比

### 当前流程

```
Case → Case Review → API/E2E Plan → Plan Review → Codegen → Run → Inspect → Heal
```

### 新流程

```
Case(含四层测试选型,人机协作)        ← aws-case-design 扩展
→ Case Review(含选型校验)             ← aws-case-reviewer 扩展
→ Plan(api/e2e/fuzz/performance)
→ Plan Review
→ Codegen
→ Run
→ Result Collection                    ← 新增
→ Quality Gate Inspect(升级自 Inspect)
→ Heal
→ Report Generation                    ← 新增
```

> 与初版差异:Target Classification **不再是 Case Review 之后的独立阶段**,而是前移并入 Case 设计。选型与 case 内容在同一个 Review gate 内被一并校验,流程更紧凑(少一个阶段、少一个 skill)。

---

## 5. 测试选型(并入 aws-case-design)

### 5.1 定位

帮助用户**选型**:确认本次变更的测试深度、广度,以及使用哪些测试工具(API / E2E / Fuzz / Performance)。

这是 `aws-case-design` 既有协作对话的扩展,**不是新 skill**。复用其 Checklist 第 6-7 步(propose 2-3 approaches → 用户确认)的人机协作模式。

### 5.2 决策树(四层,扩展自现有两层)

```
每条 Case 的验证行为:
├─ 单请求 → 响应断言            → API         (tests/api/)
├─ 用户流程 / 页面跳转          → E2E         (tests/e2e/)
├─ 复杂输入 / Schema / 边界 / Parser → Fuzz   (tests/fuzz/)
└─ 高频接口 / 核心接口 / 复杂查询 / 关键业务能力 → Performance (tests/perf/)
```

> 前两层是 `aws-case-design` 现有 `Test Layer Decision Tree`;Fuzz / Performance 为本设计新增分支。

### 5.3 交互协议

```
1. aws-case-design 在 QA 范围澄清中,逐条分析 case 验证行为
2. LLM 提议每条 case 的测试目标(api / e2e / fuzz / performance),附 reason
3. 随 2-3 coverage approaches 一并呈现,等待用户确认 / 调整
4. 用户确认后,写入 case 的 automation 字段
5. automation 一经写入,后续阶段(Plan / Codegen / Run)只读,不可覆盖
6. aws-case-reviewer 校验选型合理性(分层是否恰当、fuzz/perf 是否过度)
```

> 第 3 步的「用户确认」沿用 `aws-case-design` 既有的 HARD-GATE,无需新增确认点。

### 5.4 输出 schema(扩展 case.yaml 的 automation 字段)

现有:

```yaml
automation:
  required: true | false
  target: API | E2E | Unit | Visual | Mixed
```

扩展为:

```yaml
automation:
  required: true | false
  target: API | E2E | Fuzz | Performance | Mixed
  # 当 target 含 Fuzz:
  fuzz:
    required: true
    reason: "包含用户输入 schema,存在边界风险"
  # 当 target 含 Performance:
  performance:
    required: true
    reason: "高频核心查询接口"
    thresholds:                 # 绝对阈值(无基线,不依赖历史)
      p95_ms: 200
      error_rate_max: 0.01
      users: 50
      run_time_s: 60
  confirmed_by: user            # 标记人工确认
  confirmed_at: "2026-06-15T08:00:00Z"
```

> Performance 阈值是**绝对值**,由用户在选型时确认,不做历史基线对比。`confirmed_by` / `confirmed_at` 用于审计。

---

## 6. Planning 扩展

| 当前 | 新增 |
|------|------|
| aws-api-plan | aws-fuzz-plan |
| aws-e2e-plan | aws-performance-plan |

产物:

```
plans/
├── api-plan.md
├── e2e-plan.md
├── fuzz-plan.md
└── performance-plan.md      # 含每个性能场景的绝对阈值
```

---

## 7. Codegen 扩展

| 当前 | 新增 |
|------|------|
| aws-api-codegen | aws-fuzz-codegen |
| aws-e2e-codegen | aws-performance-codegen |

产物:

```
tests/fuzz/test_openapi_schema.py        # schemathesis
tests/perf/<capability>_locustfile.py       # Locust 脚本
```

---

## 8. Run 扩展

### Functional

```bash
pytest tests/api                    # API
pytest tests/e2e --headed           # E2E(pytest-playwright)
schemathesis run app.main:app       # Fuzz
```

### Non-Functional(Performance,简单模式)

```bash
locust -f tests/perf/<capability>_locustfile.py \
  --headless -u 50 -r 10 --run-time 60s \
  --host http://localhost:9999 \
  --json                             # 输出结构化指标
```

> **无基线**:每次运行独立采集 P95 / error_rate / RPS,直接与 plan 中的**绝对阈值**比较,不读取/写入历史基线,不做跨 change 对比。

### Coverage

```bash
pytest --cov=app --cov-report=json --cov-report=xml
```

生成 `coverage-result.json` / `coverage-result.xml`。

> **删除**:初版 §8 的 Ruff / MyPy / Bandit 静态检查不再纳入 aws-workflow。这些归 CI 门禁(GitHub Actions)独立执行。

> **工具选型**:性能采用 **Locust(Python)** 而非 k6(JS),与项目 Python / pytest / CI 生态一致。

---

## 9. Result Collection(新增)

统一收集执行结果到 `execution/`:

```
execution/
├── api-result.json
├── e2e-result.json
├── fuzz-result.json
├── performance-result.json
└── coverage-result.json
```

### Canonical Result Schema

为让 Quality Gate Inspect 能统一解析,每种 result 遵循最小 canonical schema,工具原始输出经 adapter 转换:

```json
{
  "kind": "api | e2e | fuzz | performance | coverage",
  "status": "PASS | PASS_WITH_WARNINGS | FAIL | SKIPPED",
  "summary": { "total": 36, "passed": 36, "failed": 0 },
  "details": [ /* 工具特定字段,inspect 可选读取 */ ],
  "raw_artifact": "execution/<tool>-raw.json"
}
```

Performance 的 `details` 示例(绝对阈值判定):

```json
{
  "kind": "performance",
  "status": "PASS",
  "summary": { "total": 1, "passed": 1, "failed": 0 },
  "details": [
    {
      "capability": "menu-list-query",
      "measured": { "p95_ms": 145, "error_rate": 0.0, "rps": 480 },
      "thresholds": { "p95_ms": 200, "error_rate_max": 0.01 },
      "verdict": "PASS"
    }
  ],
  "raw_artifact": "execution/runs/<batch-id>/raw/locust-stats.json"
}
```

> 各工具(pytest / schemathesis / locust / coverage.py)的 adapter 在 aws-run 内实现,把原始输出归一到上述结构。这是核心技术难点,需在 M3 design 中细化每个 adapter。

---

## 10. Quality Gate Inspect(升级自 Inspect)

### 10.1 迁移策略

**原地扩展 `aws-inspect`,不新建替换 skill**:

- 保留现有输出 `failure-analysis.json` / `failure-summary.md`(向后兼容)
- 新增输出 `quality-gate-result.json`
- aws-workflow 按 phase 版本切换,旧流程不受影响

> 不采用「新建 aws-quality-inspect 替换」方案,因为现有 aws-inspect 已被 aws-workflow 正式引用,有稳定契约。原地扩展可平滑升级。

### 10.2 检查维度

| 维度 | 检查项 | 落地 Milestone |
|------|--------|----------------|
| Functional Quality | API / E2E / Fuzz 结果 | M1(API/E2E)、M3(Fuzz) |
| Non-Functional Quality | Performance vs 绝对阈值 | M3 |
| Coverage Quality | line / branch coverage vs threshold | M1 |

(Code Quality 维度删除。)

### 10.3 状态输出

统一四态:`PASS` / `PASS_WITH_WARNINGS` / `FAIL` / `SKIPPED`

---

## 11. Coverage Gate

Coverage 不参与 Case / 选型 / Plan,仅参与 Quality Gate。

结果格式:

```json
{
  "line_coverage": 76.2,
  "branch_coverage": 64.8,
  "threshold": { "line": 70, "branch": 60 },
  "status": "PASS"
}
```

> threshold 可配置;低于阈值时 Quality Gate 标记对应状态。是否 FAIL 还是 PASS_WITH_WARNINGS 由配置决定(默认 PASS_WITH_WARNINGS,不阻断)。

---

## 12. Heal 扩展

### 允许自动修复

```
Fixture 问题 / Factory 问题 / Selector 问题
Schemathesis 配置问题(configuration-error 类)
Locust 脚本问题(脚本语法 / 错误的 endpoint / 错误的请求构造)
测试代码问题
```

### 禁止自动变绿

```
真实 API 500 / 真实产品 Bug
Coverage 不达标
Schemathesis stateful-test-failure(产品 bug 类)
Performance 不达标(measured 超过绝对阈值 → 真实性能问题,禁止改阈值变绿)
```

> **schemathesis 失败分类细化**:
> - `configuration-error`(auth / schema 配置错误)→ 允许 Heal
> - `stateful-test-failure`(产品 bug)→ 禁止 Heal,上报为 product issue

> **Performance 失败分类细化**:
> - `perf-script-error`(脚本写错 / endpoint 错 / 请求构造错)→ 允许 Heal
> - `perf-threshold-exceeded`(实测超阈值)→ 禁止 Heal,**禁止调高阈值变绿**,上报为性能问题

此列表与 C5 规则(Test Failure Integrity)完全一致。

---

## 13. Report Generation(新增终态阶段)

新增 skill `aws-report-generator`,职责单一:将执行结果转换为研发可读的质量报告。

### 输入

```
execution/*
review/*
failure-analysis.json
quality-gate-result.json
```

### 输出

```
report/
├── executive-summary.md
├── quality-report.md
└── quality-report.json
```

---

## 14. Report 结构

### Executive Summary

```
Change ID / Final Status / Quality Score / Risk Level / Recommendation
```

### Quality Score 算法(确定性公式)

**确定性公式**,避免 LLM 自由打分导致不可比较。完整四维:

```
Quality Score = Functional(50) + Coverage(20) + Fuzz(15) + Performance(15)

  Functional(50)  = 50 × (api_passed + e2e_passed) / (api_total + e2e_total)
  Coverage(20)    = 20 × min(line_coverage / line_threshold, 1.0)
  Fuzz(15)        = 15 × (fuzz_passed / fuzz_total)
  Performance(15) = 15 × (perf_passed / perf_total)
```

**按 Milestone 退化**(无对应 target 的维度标 N/A,权重按比例重分配到已落地维度):

```
M1:  Functional(70) + Coverage(30)                          [无 fuzz/perf]
M3:  Functional(50) + Coverage(20) + Fuzz(15) + Performance(15)  [全量]
```

> 分数确定可复现。Risk Level(LOW/MEDIUM/HIGH)由 LLM 综合判断,但必须在报告中说明判断依据,且不得改变 final_status。

### 其余章节

- **Scope**:Cases / 各类测试 / 覆盖的需求 REQ
- **Functional Quality**:API / E2E / Fuzz 通过情况
- **Non-Functional Quality**:Performance 各场景实测值 vs 阈值
- **Coverage Analysis**:line / branch / 未覆盖关键文件
- **Defects Found**:分类为 Product Issues / Test Issues / Environment Issues
- **Risk Analysis**:LLM 汇总剩余风险 + 潜在影响 + 建议关注点
- **Release Recommendation**:建议上线 / 建议上线但需关注 / 不建议上线

---

## 15. 新增 / 改动 Skills 清单

| Skill | 阶段 | 类型 | 说明 |
|-------|------|------|------|
| aws-case-design | M3 | 改动 | 决策树扩展为四层;automation schema 加 fuzz / performance |
| aws-case-reviewer | M3 | 改动 | 校验四层选型合理性 |
| aws-fuzz-plan | M3 | 新增 | Fuzz 计划生成 |
| aws-fuzz-codegen | M3 | 新增 | schemathesis 测试代码生成 |
| aws-performance-plan | M3 | 新增 | Performance 计划生成(含绝对阈值) |
| aws-performance-codegen | M3 | 新增 | Locust 脚本生成 |
| aws-report-generator | M1 | 新增 | 质量报告生成 |

> - **删除** `aws-target-classifier`:选型并入 `aws-case-design`(v2 调整 V1)。
> - aws-inspect 原地扩展,不新建 aws-quality-inspect。

---

## 16. 分期计划

### M1 · Quality Reporting(2-3 周,零新依赖风险)

```
- pytest-cov 接入 aws-run(--cov 参数)
- aws-inspect 新增 Coverage 解析 + quality-gate-result.json
- aws-report-generator(新 skill):基于现有 result 生成质量报告
- Quality Score 确定性公式落地(M1 退化版:Functional 70 + Coverage 30)
```

新增 skill:`aws-report-generator`。前置:无。**可立即启动。** 详见 [2026-06-15-m1-quality-reporting-design.md](./2026-06-15-m1-quality-reporting-design.md)。

### M3 · Fuzz + Performance Flow(4-5 周)

```
- aws-case-design 决策树扩展四层 + automation schema 加 fuzz/performance
- aws-case-reviewer 选型校验
- aws-fuzz-plan + aws-fuzz-codegen(schemathesis)
- aws-performance-plan + aws-performance-codegen(Locust,绝对阈值,无基线)
- schemathesis + locust 接入 aws-run + canonical adapter
- Fuzz / Performance 结果纳入 Quality Gate
- Quality Score 切全量四维
```

新增 skill:`aws-fuzz-plan` / `aws-fuzz-codegen` / `aws-performance-plan` / `aws-performance-codegen`。
改动 skill:`aws-case-design` / `aws-case-reviewer` / `aws-run` / `aws-inspect` / `aws-report-generator`。

> Fuzz 与 Performance 同期:去掉基线后,Performance 变为无状态、绝对阈值判定,结构与 Fuzz 对称,二者共享「决策树扩展 + 新 plan/codegen skill + canonical adapter」模式,合并交付效率更高。

> M1 阶段仍走现有 api/e2e 选型逻辑;四层选型在 M3 落地。

---

## 17. 待后续 design 细化的开放项

| 编号 | 开放项 | 归属 Milestone |
|------|--------|----------------|
| O1 | 每个工具的 canonical result adapter 具体映射(pytest / schemathesis / locust / coverage) | M3 |
| O2 | case.yaml 加 fuzz / performance 字段后,aws-case-design / reviewer / fixer 的 Context Contract 同步更新 | M3 |
| O3 | Coverage threshold 默认值与可配置方式 | M1(已在 M1 design 决议) |
| O4 | Risk Level 判断的 LLM prompt 与依据格式 | M1(已在 M1 design 决议) |
| O5 | Locust 执行的环境前置(host 可达性 / 服务预热)与 SKIPPED 判定 | M3 |
| O6 | Performance 绝对阈值的默认建议值(用户未指定时是否给默认) | M3 |

---

## 18. 最终闭环

```
Case(含四层测试选型,人机协作)
→ Case Review(含选型校验)
→ Plan(api / e2e / fuzz / performance)
→ Plan Review
→ Codegen
→ Run
→ Result Collection
→ Quality Gate Inspect
→ Heal
→ Report Generation
```

实现:

```
Case 驱动测试资产生成(含工具选型)
Quality Gate 驱动质量结论
Report 驱动上线决策
```
