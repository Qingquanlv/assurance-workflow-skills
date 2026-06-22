# M3 实施计划:Fuzz + Performance Flow（执行层）

> 状态：待批准（生成于 2026-06-15）
> 设计依据：
> - [2026-06-15-m3-fuzz-performance-design.md](./2026-06-15-m3-fuzz-performance-design.md)（M3 总设计）
> - [2026-06-15-aws-case-design-redesign.md](./2026-06-15-aws-case-design-redesign.md)（Phase A 细化，Model A）
> 本文只写「怎么落地」：任务拆解、依赖、并行编排、验证 gate、subagent 派发。
> 设计上的「做什么/为什么」见上述两份文档，不重复。

---

## 0. 前置决策（必须先确认）

### D-0：Phase D 依赖 M1，M1 尚未实现

M3 Phase D（Quality Gate + Report 接入）依赖 M1 的产物：
- `quality-gate-result.json`（M1 定义的契约）
- `aws-report-generator` skill + `src/report/report_generator.ts`（M1 新建）

**M1 目前只有设计文档（`2026-06-15-m1-quality-reporting-design.md`），代码未落地。**

因此本计划默认采用 **方案 ②**（见下）。若你选其它方案，Phase D 的边界需相应调整：

| 方案 | 内容 | Phase D 状态 |
|------|------|--------------|
| ① 先做 M1 再做 M3 | M1 全量落地后再开 M3 | Phase D 可完整落地 |
| ②（默认）M3 A/B/C 先行，D 待 M1 | A/B/C 不依赖 M1，先交付 Fuzz/Perf 闭环；D1/D2 标记为 **BLOCKED-ON-M1** | D1/D2 暂缓，D3/D4 可做 |
| ③ M1 + M3 合并一把推 | 范围最大，先补 M1 的 quality-gate + report 基座再叠 M3 | Phase D 完整 |

> 默认按 ② 执行：**A/B/C 全做，D3/D4 做，D1/D2 留到 M1 落地后**。这样 Fuzz/Perf 的 plan→review→codegen→run→inspect 链路本期就能跑通，只是结果汇总进 Quality Score 的那一步等 M1。

---

## 1. 任务依赖图

```
Phase A (基础，全员依赖)
  A1 ──┐
  A2 ──┴──> A3
            │
   ┌────────┴─────────┐
   ▼                  ▼
Phase B (Fuzz)     Phase C (Performance)   ← B、C 互相独立，可并行
  B1 ─> B2 ─> B3     C1 ─> C2 ─> C3 ─> C4
   └────────┬─────────┘
            ▼
Phase D (汇总接入)
  D3 ─> D4            （D1/D2 BLOCKED-ON-M1，默认方案②暂缓）
```

依赖事实：
- A1 是纯 bug 修复，**不依赖任何东西**，可最先做。
- A2（case-design 四层扩展）依赖 A1 的 schema 决定。
- A3（reviewer + api-plan/e2e-plan 改读 `type`）依赖 A1/A2 的 `type` 单一事实源。
- B 与 C **并行**：都只依赖 Phase A，codegen/run 互相独立。
- D3（workflow 序列）、D4（集成测试/config/依赖）依赖 B、C 完成。
- D1（quality-gate 维度）、D2（report 四维 Score）依赖 **M1**。

---

## 2. Phase A — 四层选型基础

### A1：aws-case-design 修 A 类 bug（纯一致性修复）

文件：`skills/aws-case-design/SKILL.md`（+ 已先行改了 frontmatter description、第3/7类问题表）

| 改动 | 位置（设计依据） |
|------|------------------|
| 全文 `automation_targets` → `automation` 表述 | redesign §9 表 |
| 删除 `automation.target` 字段，`type` 成单一事实源 | redesign §3.1 |
| `type` 枚举去掉 `Unit / Visual / Mixed` | redesign §3.1 |
| 决策树正文「before assigning `automation_targets`」→「assigning each case's `type`」 | redesign §9 |
| Layer Rationale「cross-check `automation_targets`」→「cross-check each case's `type`」 | redesign §9 |
| readiness check #44 保留「禁止 `automation_targets` 字段」 | redesign §8 |

下游同步（属 A1，因为是 bug 修复）：
- `skills/aws-case-reviewer/SKILL.md` §13 Layering Review：读 `automation_targets` → 读 `type`
- `skills/aws-api-plan/SKILL.md`：筛选条件 → `type == API && automation.required`
- `skills/aws-e2e-plan/SKILL.md`：筛选条件 → `type == E2E && automation.required`

**验证**：grep 确认仓库无残留 `automation.target` schema 字段、无矛盾的 `automation_targets` 字段引用；schema 示例 YAML 与 readiness check 自洽。

### A2：aws-case-design 四层扩展

文件：`skills/aws-case-design/SKILL.md`

| 改动 | 设计依据 |
|------|----------|
| `type` 枚举加 `Fuzz / Performance` | redesign §3.1 |
| `automation.framework` 加 `schemathesis / locust` | redesign §3.2 |
| 决策树两层 → 四层 + Hard rules（Fuzz 不替代功能断言、Perf 必带阈值、附加 case） | redesign §4 |
| `automation` 块加 `confirmed_by/confirmed_at` 锁定 | redesign §3.2 |
| `automation.fuzz`（endpoints/expectations）/ `automation.performance`（scenario/thresholds/load）子块 | redesign §3.2 |
| framework↔type↔目录对应表 | redesign §3.3 |
| Layer Rationale 示例覆盖四类 | redesign §6 |
| case_id 中缀约定（FUZZ/PERF） | redesign §7 |
| readiness check：`type` 四枚举、framework 匹配、Fuzz 必有 endpoints、Perf 必有 thresholds、Fuzz 必有 related_cases | redesign §8 |

**验证**：schema 示例 + readiness check + 决策树三处对四类 type 完全自洽；无 `Mixed` 残留。

### A3：下游按 type 筛选（与 A1 合并交付）

见 A1「下游同步」。`aws-case-reviewer` §13 额外加 fuzz/perf 反模式表（M3 §4.4）：
- Fuzz 无对应 API case → Type 2 `human_review_required`
- Fuzz 标在纯读接口 → Type 1 `fix_scope: ["automation.fuzz"]`
- Perf 标在低频接口 → Type 1 `fix_scope: ["automation.performance"]`
- Perf 缺 thresholds → Type 2 blocker
- 同断言点 API/Fuzz 重复 → Type 2 断言迁移

**Phase A 出口 gate**：`npm run build`（若 skill 改动不涉及 TS 可省）+ 人工读一遍 case-design SKILL.md 四层自洽。

---

## 3. Phase B — Fuzz Flow（复用 pytest）

### B1：三个新 skill（镜像 aws-api 三件套）

新建目录与 `SKILL.md`：
- `skills/aws-fuzz-plan/`：读 `type == Fuzz` 的 case；产 `plans/fuzz-plan.md` / `fuzz-codegen-plan.md` / `fuzz-review-summary.md`（不生成代码）— 镜像 `aws-api-plan`
- `skills/aws-fuzz-plan-reviewer/`：产 `review/fuzz-plan-review.json`，gate 字段同 api-plan-review — 镜像 `aws-api-plan-reviewer`
- `skills/aws-fuzz-codegen/`：gate=`fuzz-plan-review.json` pass；产 `tests/fuzz/test_<module>_fuzz.py`（schemathesis `@schema.parametrize`，`from_asgi` 优先）；继承 C5 Test Failure Integrity — 镜像 `aws-api-codegen`

### B2：CLI 执行（复用 pytest_runner）

- `src/execution/runner.ts`：`discoverTargets(..., 'fuzz-codegen-plan.md', ..., ['tests/fuzz'])`，跑 `runPytest`，写 `fuzz-result.json`（per-run + latest）
- `src/execution/result_parser.ts`：Fuzz 复用 `parsePytestXml`，归一 `kind: "fuzz"`
- `src/core/types.ts`：`FuzzResult`（复用 `ApiResult` 形态）

### B3：aws-inspect fuzz 失败分类

- `src/report/inspector.ts` + `skills/aws-inspect/SKILL.md`：
  - `configuration-error`（auth/schema 配置）→ `fix_proposal_eligible: true`
  - `stateful-test-failure`（产品 5xx / schema 违约）→ `fix_proposal_eligible: false`

**Phase B 出口 gate**：`npm run build` + `npm test`（fuzz runner 集成测试，见 D4）通过。

---

## 4. Phase C — Performance Flow（新增 Locust runner，最重）

### C1：三个新 skill

- `skills/aws-performance-plan/`：读 `type == Performance`；产 `plans/performance-plan.md`（endpoint/负载档位/绝对阈值）/ `performance-codegen-plan.md`（`tests/perf/<capability>_locustfile.py` 映射）/ `performance-review-summary.md`
- `skills/aws-performance-plan-reviewer/`：产 `review/performance-plan-review.json`；额外校验 thresholds 完整（p95_ms/error_rate_max）、负载档位非 0、阈值非占位符
- `skills/aws-performance-codegen/`：gate=review pass；产 `tests/perf/<capability>_locustfile.py`（Locust `HttpUser`）；C5 规则

### C2：locust_runner + parser + 阈值判定（核心新增）

- `src/execution/locust_runner.ts`（**新建**，镜像 `playwright_runner.ts`）：
  1. 读 scenarios 取 host/阈值/负载档位
  2. **环境前置探测**：host 不可达 → scenario `SKIPPED`（不误报 FAIL，O5）
  3. `spawnSync`：`locust -f <file> --headless -u <users> -r <spawn_rate> --run-time <s>s --host <host> --json`
  4. 解析 stdout JSON / `--csv`，取 p95/error_rate/rps
  5. 判定：`p95_ms<=阈值 && error_rate<=阈值` → PASS；任一超 → FAIL
  6. 归一为 canonical `performance-result.json`
- `src/execution/result_parser.ts`：新增 Locust stats parser

### C3：runner.ts 接 perf 执行

- `src/execution/runner.ts`：跑 `runLocust`，写 `performance-result.json`（per-run + latest）
- `src/core/types.ts`：`PerformanceResult`

### C4：aws-inspect perf 失败分类

- `src/report/inspector.ts` + `skills/aws-inspect/SKILL.md`：
  - `perf-script-error` → `fix_proposal_eligible: true`
  - `perf-threshold-exceeded` → `fix_proposal_eligible: false`（禁止改阈值变绿）
  - `perf-environment`（host 不可达）→ `SKIPPED`

**Phase C 出口 gate**：`npm run build` + locust_runner 单测/集成测试通过；不可达 host 场景产出 SKIPPED 而非 FAIL。

---

## 5. Phase D — 汇总接入

### D3：aws-workflow phase 序列接入 fuzz/perf 分支（可做）

- `skills/aws-workflow/SKILL.md`：在 plan/codegen/run 阶段加 fuzz/perf 分支；change 不含 fuzz/perf 目标时流程与现状一致（维度标 N/A / SKIPPED）

### D4：集成测试 + config + 依赖（可做）

- `.aws/config.yaml` 模板：fuzz/performance 开关 + 默认负载档位
- 依赖声明：`schemathesis` / `locust`（目标项目 dev 依赖）
- `tests/integration/`：fuzz（复用 pytest）+ locust runner 集成测试

### D1：quality-gate-result.json 加 fuzz + non_functional 维度 ⚠️ BLOCKED-ON-M1

- 依赖 M1 的 `quality-gate-result.json` 契约与 `src/report/inspector.ts` quality-gate 合成逻辑
- M1 落地后：functional 加 `fuzz` 子项，新增 `non_functional.performance[]` 维度，`final_status` worst-wins 纳入

### D2：aws-report-generator 四维 Score + Non-Functional 章节 ⚠️ BLOCKED-ON-M1

- 依赖 M1 的 `aws-report-generator` + `report_generator.ts`
- M1 落地后：Quality Score 切 TRD §14 四维（Functional50+Coverage20+Fuzz15+Perf15）；报告加 Non-Functional Quality 章节

**Phase D 出口 gate**：`npm run build` + 全量 `npm test` 通过；workflow 跑一个不含 fuzz/perf 的 change 与现状行为一致（回归）。

---

## 6. 执行编排与 subagent 派发

| 批次 | 任务 | 并行性 | 派发方式 |
|------|------|--------|----------|
| 1 | A1 + A3 下游 | 串行（同改 case-design schema） | 主 agent 亲自做（基础、需一致性） |
| 2 | A2 | 接 A1 | 主 agent 亲自做 |
| 3 | B（B1→B2→B3） / C（C1→C2→C3→C4） | **B、C 并行** | 两个 subagent 并行（各自含详细 context：镜像哪个现有 skill、产物路径、gate 字段） |
| 4 | D3、D4 | D3、D4 可并行 | subagent 或主 agent |
| 5 | D1、D2 | BLOCKED-ON-M1 | 暂缓 |

派发原则（subagent-driven）：
- 每个 subagent 给完整 context（无对话历史）：要镜像的现有文件路径、目标产物、gate 契约、C5 规则要求
- 每批结束跑 `npm run build` + 相关测试，作为合入 gate
- B、C 因互相独立，适合一条消息内派两个并行 subagent

---

## 7. 验证策略（每阶段 gate）

| 阶段 | 验证命令 / 检查 |
|------|------------------|
| A | grep 无 `automation.target` 字段残留；case-design 四层自洽；`npm run build` |
| B | `npm run build`；fuzz runner 集成测试；fuzz codegen 产物符合 schemathesis 形态 |
| C | `npm run build`；locust_runner 测试；不可达 host → SKIPPED 验证 |
| D3/D4 | `npm run build`；全量 `npm test`；无 fuzz/perf change 回归一致 |

> 遵循 verification-before-completion：每阶段先跑命令拿到证据再宣称完成，不臆断。

---

## 8. 风险与开放项（承接 M3 §10 / redesign §12）

| 编号 | 风险/开放项 | 处置 |
|------|-------------|------|
| D-0 | Phase D 依赖 M1 | 默认方案②，D1/D2 暂缓；需你确认 |
| O5 | Locust host 不可达 | SKIPPED 不误报 FAIL，runner 启动前探测 |
| O6 | Perf 阈值默认值 | 不给默认，reviewer 标 blocker 要求人工补 |
| O7 | 是否建独立 fuzz/perf fixer | M3 先不建，Heal 仅处理 script-error/config-error 类 |
| O9 | schemathesis ASGI vs URL | 优先 `from_asgi`，结构不便回退 `from_uri` |
| R1 | 存量 case.yaml 含旧 `automation.target` | reviewer 读 `type` 优先，容忍旧字段；或一次性对齐脚本 |

---

## 9. 已确认的执行决策（2026-06-15）

1. **D-0 方案 = ③（M1 + M3 合并一把推）**：先全量落地 M1（Coverage + Quality Gate + Report 基座），再做 M3 A→B→C→D。Phase D 的 D1/D2 不再 BLOCKED——直接扩展刚落地的 M1 `inspector.ts` / `report_generator.ts`。
2. **执行方式 = 主 agent 顺序做**（不派 subagent），逐 Step 线性推进，每阶段跑 `npm run build` + 相关测试作为 gate。
3. 合并后总顺序见 §10。

---

## 10. 合并执行顺序（M1 → M3）

```
=== M1（基座，先做）===
 M1-1  types.ts: CoverageResult / QualityGateResult / QualityReport
 M1-2  pytest_runner.ts coverage 参数 + 能力探测；coverage_parser.ts
 M1-3  runner.ts 写 coverage-result.json(per-run+latest)；aws-run skill 同步
 M1-4  inspector.ts 合成 quality-gate-result.json；aws-inspect skill 同步
 M1-5  report_generator.ts + report.ts `generate` 子命令 + quality_score(退化二维)
 M1-6  aws-report-generator skill
 M1-7  aws-workflow 追加 Report phase
 M1-8  .aws/config.yaml coverage 块 + 集成测试

=== M3 Phase A（选型基础）===
 A1   aws-case-design 修 A 类 bug + 下游(reviewer/api-plan/e2e-plan)改读 type
 A2   aws-case-design 四层扩展
 A3   aws-case-reviewer §13 四层选型校验

=== M3 Phase B（Fuzz，复用 pytest）===
 B1   aws-fuzz-plan / *-reviewer / aws-fuzz-codegen
 B2   runner.ts fuzz target + 复用 pytest parser；types.ts FuzzResult
 B3   aws-inspect fuzz 失败分类

=== M3 Phase C（Performance，新 runner）===
 C1   aws-performance-plan / *-reviewer / aws-performance-codegen
 C2   locust_runner.ts + Locust parser + 阈值判定 + 环境 SKIPPED
 C3   runner.ts perf 执行；types.ts PerformanceResult
 C4   aws-inspect perf 失败分类

=== M3 Phase D（汇总接入，扩展 M1 基座）===
 D1   inspector.ts quality-gate 加 fuzz + non_functional 维度
 D2   report_generator.ts 切四维 Score(Func50+Cov20+Fuzz15+Perf15) + Non-Functional 章节
 D3   aws-workflow 加 fuzz/perf 分支
 D4   集成测试 + config(fuzz/perf 块) + schemathesis/locust 依赖
```

> Quality Score 演进:M1 退化二维 `Functional(70)+Coverage(30)` → M3 D2 全量四维 `Functional(50)+Coverage(20)+Fuzz(15)+Performance(15)`，report_generator 按已落地维度选公式。
