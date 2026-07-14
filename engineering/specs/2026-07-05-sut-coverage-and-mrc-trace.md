# 被测服务覆盖率 + Minimum Required Coverage 追踪 Spec

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

**日期**: 2026-07-05
**版本**: v1.0
**状态**: Draft
**范围限定**: 仅 Python 被测系统（FastAPI/uvicorn 形态优先）
**涉及面**: `src/execution/{runner,pytest_runner,coverage_parser}.ts`、`src/report/{quality_gate,inspector,execution_artifacts}.ts`、`schemas/explore-advisory.schema.json`、`skills/aws-{explore,case-design,case-reviewer,api-plan-reviewer,e2e-plan-reviewer,run,report}/SKILL.md`、`src/templates/config-yaml.ts`
**关联**:
- [2026-07-04-run-integrity-tests-hash-guard.md](2026-07-04-run-integrity-tests-hash-guard.md)（run 完整性；本 spec 的 coverage 采集同样以 `aws run` 为唯一入口）
- `engineering/design/two-stage-intake-execution.md`（advisory / case-design 的 mode 与 gate 框架）

---

## 0. 问题与目标

### 0.1 实测事实（RET-api-management，vue-fastapi-admin）

1. **代码覆盖率全空**：API 测试是黑盒 HTTP（`httpx.Client(base_url=…)` 调 9999 端口运行中的服务），pytest 进程从不 import `app/`。`execution/coverage-result.json` 实际为 `available: false / SKIPPED`。即使装了 pytest-cov，`--cov=app` 也只会得到 0%——被测代码在另一个进程。
2. **MRC 有数据、无闭环**：`risk-advisory/advisory.json` 的 `minimum_required_coverage` 有 24 项（api 8 + e2e 6 + negative 7 + data_integrity 3），但只是字符串数组；case.yaml 的 `trace` 为空；case-design 之后**没有任何阶段再读过 MRC**。这次 24 项恰好都被 24 个 case 覆盖是 LLM 自觉，无机制核对——漏一项不会被任何 gate 发现。

### 0.2 目标

| # | 目标 | 判据 |
|---|---|---|
| A | 被测服务进程级覆盖率：总量 + 本次 scope（模块/影响文件）+（可选）diff | `coverage-result.json` `available: true` 且数字来自 SUT 进程 |
| B | endpoint → handler 覆盖映射 | 每个路由能回答"handler 函数被执行过没有" |
| C | MRC 全链路推进：explore → case → review gate → plan → 执行 | required 项漏 case 在 **case-review** 被拦，而非报告期 |
| D | MRC 最终判定进报告 | report 输出每项 mapped/executed/verified 三级判定 |

**总原则**：宁可 `SKIPPED` 也绝不伪造数字；coverage gap 与 MRC missing 均**不进 healing**（不是"测试写错"，是"缺测试/缺范围"，需人工决策）。

---

## Part A — 被测服务覆盖率（Python）

### A.1 server-process coverage 模式

coverage.py **无法 attach 到已运行进程**（硬约束）。因此 `aws run` 必须接管 SUT 生命周期：

```text
aws run (coverage.mode == server-process):
  1. 若配置端口已有进程监听 → STOP（防止旧服务残留导致静默零覆盖），提示先停止
  2. spawn: uv run coverage run --branch -m uvicorn app:app --port <port>
     - 禁 reload（uvicorn reload spawn 子进程，覆盖会丢）
     - 多 worker 需 COVERAGE_PROCESS_START + concurrency=multiprocessing（v1 限单 worker）
  3. 等待就绪（复用现有 _verify_sut_ready 探活逻辑）
  4. 跑 API + E2E（同一 server → E2E 驱动的后端覆盖免费获得）
  5. SIGTERM 停服务 → coverage 落盘 → coverage combine → coverage json/xml 到 batch raw/
  6. 现有 coverage_parser.ts 直接消费（格式不变）
```

**配置（`.aws/config.yaml` coverage block 扩展）**：

```yaml
coverage:
  enabled: true
  mode: pytest-cov | server-process     # 新增；默认 pytest-cov（向后兼容）
  server_command: "uvicorn app:app --port 9999"
  server_port: 9999
  target_package: app
  threshold:
    line: 70            # project 级，默认 gate_mode: warn
    module_line: 80     # 新增：scope 内文件聚合阈值
    diff_line: 90       # 新增：仅当存在代码 diff 时生效
  gate_mode: warn
```

**防呆（不可伪造）**：

- coverage 数据文件缺失 / totals 全零而测试确实通过了 → `status: SKIPPED, skip_reason: server_not_under_coverage`，绝不写数字
- server 启动失败 → 测试照常跑（不因 coverage 阻塞执行），coverage `SKIPPED, skip_reason: server_start_failed`

### A.2 scope（模块/影响文件）coverage

数据源已现成：advisory 的 `test_strategy.scope.in_scope`（如 `app/controllers/api.py`, `app/schemas/apis.py`）。

- `CoverageResult` 新增 `scope` 段：

```json
"scope": {
  "source": "advisory.test_strategy.scope.in_scope",
  "files": [
    { "file": "app/controllers/api.py", "line_coverage": 87.5 }
  ],
  "module_line_coverage": 84.2,
  "threshold": 80,
  "status": "PASS"
}
```

- 纯 TS 层计算（coverage.json 逐文件 summary 过滤 + 聚合），无新 Python 依赖
- quality gate coverage 维度改为**取 project 与 module 的 worst**；默认仍 warn

### A.3 diff coverage（有条件启用）

- 仅当 change 存在代码 diff 时激活：`git diff -U0 <base>` 的行区间 ∩ coverage.json `executed_lines`
- RET-* 回归型 change 常无 diff → 输出 `N/A (no code diff)`，不参与 gate
- v1 可后置（见实施顺序）

### A.4 endpoint → handler 映射

- 新增脚本产物 `execution/runs/<batch>/routes.json`（`aws run` 在 SUT venv 里跑一个 route-dump 脚本）：

```json
[{ "method": "POST", "path": "/api/v1/api/refresh",
   "handler": "app/controllers/api.py::refresh_api" }]
```

- 判定分两级：
  - **文件级**（保底，任何 coverage 版本）：handler 所在文件 line coverage
  - **函数级**（coverage.py ≥ 7.5 的 JSON 含 per-function 区域）：`refresh_api` 函数 executed 与否
- 消费方：Part B 的 MRC 代码级佐证（B.5）与 report

---

## Part B — Minimum Required Coverage 追踪

### B.1 advisory 结构化（schema 变更）

`minimum_required_coverage` 从字符串数组升级为对象数组（`schemas/explore-advisory.schema.json`）：

```json
{
  "id": "MRC-API-006",
  "key": "refresh_api",
  "category": "api | e2e | negative | data_integrity",
  "required": true,
  "layer": "api | e2e | both",
  "enabled_when": "e2e in test_types",        // e2e 项必填
  "target": {                                  // 可选；代码级佐证用
    "endpoint": "POST /api/v1/api/refresh",
    "handler": "app/controllers/api.py::refresh_api"
  },
  "advisory_refs": ["PH-002", "SS-003"],
  "acceptance": "at least one automated case executed"
}
```

兼容策略：validator 遇到旧字符串数组 → warning + 按 `{key, required: true}` 宽松解释，不 hard error（一个版本后收紧）。

### B.2 case-design：显式绑定 + 覆盖矩阵

- 每个 case 的 `trace` 回填：

```yaml
trace:
  minimum_required_coverage: [MRC-API-006]
  advisory_refs: [PH-002, SS-003]
```

- 新产物 `trace/minimum-coverage-matrix.yaml`（case-design 写，后续只读）：

```yaml
- mrc_id: MRC-API-006
  key: refresh_api
  required: true
  covered_by_cases: [TC_API_012, TC_API_013]
  status: covered | skipped_by_scope
  skip_reason: null
```

### B.3 case-review gate（推进的第一道强制）

新增 hard rules：

| 情况 | verdict |
|---|---|
| `required: true` 且无任何 case 引用 | `needs_fix` |
| 覆盖层错误（api 项只被 E2E case 覆盖等） | `needs_fix` |
| E2E 关闭但 e2e 项无 `skipped_by_scope` + reason | `needs_human_review` |
| matrix 与 case.yaml trace 不一致 | `needs_fix` |

`case-review.json` 新增汇总段：

```json
"minimum_coverage": { "total_required": 24, "covered": 24, "skipped_by_scope": 0, "missing": [] }
```

### B.4 plan / codegen / run：沿现有 case_id 链路，零新机制

- plan-review：核对 matrix 中的 `case_id` 均出现在 plan（防"case 有、plan 丢"断链）
- codegen：现有 `case_id → test_tc_xxx__` 函数名规则已够
- `aws run`：现有 result.json 已含 `case_id + status`，不改

### B.5 report：三级判定 + 状态归类

对每个 MRC 项：

```text
mapped    ← matrix 有 ≥1 case_id
executed  ← 这些 case_id 出现在本 batch result.json
verified  ← 执行状态满足验收（下表）
corroborated（可选）← target.handler 函数在 A.4 覆盖数据中 executed
```

状态归类：

| 执行状态 | MRC 判定 | 备注 |
|---|---|---|
| 全部 passed | `covered` | |
| xfail/skipped 且关联 known-product-issue | `covered_known_issue` | 算覆盖，单独列出（例：TC_API_013 / PH-002） |
| 任一 failed | `covered_but_failing` | 不算达标 |
| 有 case 但本 batch 未执行 | `not_executed` | |
| 无 case 引用 | `missing` | required 项 missing → 该维度 FAIL |

新产物 `report/minimum-coverage-result.json` + report md 段：

```text
Minimum Required Coverage: 23 covered + 1 covered_known_issue / 24, missing 0
  data_integrity:
    refresh_orphan_preservation  covered_known_issue  (TC_API_013 xfail, PH-002)  handler executed ✓
```

### B.6 与 healing / gate 的边界

- MRC `missing` / `covered_but_failing` 与 coverage gap 一样 `fix_proposal_eligible: false` —— **不进 healing**，进 report 让人决策（补 case / 扩 scope / 接受）
- 判定失败默认不阻塞 report 生成（report 是 terminal 产物）；是否把 `missing required` 升级为 archive blocker：**是**（archive gate 增读 `minimum-coverage-result.json`，missing > 0 → not eligible）

---

## C. 验收标准

1. **A 线**：在 vue-fastapi-admin 以 server-process 模式跑一轮 → `coverage-result.json` `available: true`，project + scope 两组数字；旧服务残留场景 → `SKIPPED, server_not_under_coverage`（不伪造）
2. **B 线**：删除 matrix 中任一 required 映射 → case-review gate `needs_fix`；重演 RET-api-management → report 输出 24 项判定，TC_API_013 归 `covered_known_issue`
3. 单测：coverage scope 聚合、routes.json 解析、MRC 判定归类（含 xfail/missing/not_executed）、旧字符串数组兼容
4. `tsc --noEmit` + 全量 jest 通过；**`npm run build` 后 dist 验证**（教训条款）

## D. 实施顺序

1. B.1 schema 结构化 + validator 兼容（纯增量）
2. B.2/B.3 case-design 绑定 + matrix + case-review gate（推进闭环，收益最先落地）
3. B.5 report 三级判定 + archive gate 增读（判定闭环）
4. A.1/A.2 server-process coverage + scope 聚合（代码覆盖可信化）
5. A.4 routes.json + 函数级佐证（钉住 MRC 与代码）
6. A.3 diff coverage（backlog 边缘，视 change 是否常有代码 diff）

### Backlog（显式不做）

- per-case 覆盖归因（需 test-id header + coverage context 中间件，成本高）
- 多 worker / reload 模式下的 server coverage（v1 限单 worker、禁 reload）
- 非 FastAPI 框架的 route dump 适配
