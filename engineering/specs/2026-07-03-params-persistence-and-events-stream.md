# 运行参数落盘 + 结构化事件流（events.jsonl）

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

**日期**: 2026-07-03
**版本**: v1.0
**状态**: Draft
**涉及面**: `src/core`（新模块）、`src/commands/{status,gate,run}.ts`（埋点）、`skills/aws-workflow/SKILL.md`（initial fields 模板）
**关联**: openchamber `docs/specs/qa-panel-consolidation.md` WS4（本 spec 的产物是其 SSE 数据源升级）

---

## 背景与动机

两个独立但同源的问题，源头都是"orchestrator 的运行时决策没有留下机器可读的痕迹"：

### 问题 1：测试类型选择不落盘

哪些测试类型要执行，目前分三层，一层缺口：

| 数据 | 落地位置 | 状态 |
|------|---------|------|
| 运行时参数 `test_types` / `run_mode`（用户消息覆盖） | 无 | ❌ 不落盘 |
| case-design 反问确认的类型 | `proposal.md ## Test Types` + case `type` 字段 | ✅（半结构化） |
| Phase 2.5 Layer Scan 结果 | `workflow-state.yaml.layers.{api,e2e,fuzz,performance}` | ✅（机器可读） |

不落盘不只是观测问题，**还是编排一致性 bug**：

- `workflow-schema.yaml` 的 `params:` 段定义了 `run_mode` / `test_types` 等参数及默认值
  （实例见 `vue-fastapi-admin/.aws/workflow-schema.yaml` L33-40）。
- `src/orchestration/engine.ts` L144-147 **已经实现**了从 `workflow-state.yaml.params`
  读取覆盖值的逻辑（`Object.assign(this.params, stateParams)`），phase 的 `when` 谓词
  剪枝依赖这些参数。
- 但 `aws-workflow/SKILL.md` 的 initial workflow-state 模板（L296 起）从未要求写 `params:` 块
  （实测 RET-role-management 的 state 文件无此块）。

后果：用户说"只跑 api"时，LLM 按 `test_types=api` 分支执行，但 `aws status --next` 仍按
默认 `[api,e2e]` 计算 DAG——会持续推荐 e2e phase，状态机与实际执行脱节；事后也无法从
产物复现当时的执行决策。

### 问题 2：过程感知靠翻聊天

workflow 跑到哪个阶段、每个 phase 耗时多少、gate 何时 BLOCK、fix loop 重试了几次，
只存在于聊天流里。`workflow-state.yaml` 是**当前状态快照**（且无任何时间戳，实测确认），
表达不了历史与耗时。UI（openchamber QA 面板）只能靠 watch 文件系统推断变更，语义粗糙。

**目标**：
1. 运行参数写入 `workflow-state.yaml.params`（复用引擎已有消费逻辑，零 CLI 改动）。
2. 每个 phase 迁移/gate 裁决/测试执行追加一条 JSON 到 `qa/changes/<id>/events.jsonl`，
   由 **CLI 在 orchestrator 必经命令里自动发射**，不依赖 LLM 手写。

---

## 设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 参数落盘字段名 | 复用 `workflow-state.yaml.params`（不新造 `runtime_params`） | `engine.ts` 已消费该字段；写入即同时修复 status DAG 与实际执行不一致的 bug |
| 参数写入者 | orchestrator（LLM，Phase 1.1 initial state 模板） | workflow-state 本就是 orchestrator-owned LLM 写入；CLI 管不到 initial 写入时机 |
| 事件写入者 | **CLI 自动发射**（status / gate check / run 三处埋点），不新增 `aws events emit` 命令 | orchestrator 每迭代必调 `aws status --next --json`、每 gated phase 必调 `aws gate check`——事件搭在必经调用上，SKILL.md 零改动，彻底消除"LLM 漏调 emit"风险 |
| phase 迁移检测 | `aws status` 内做快照 diff（本次 computeStatus 结果 vs events.jsonl 中各 phase 最后记录状态） | computeStatus 本就算出全量 phase 状态；diff 保证幂等（重复调 status 不刷重复事件） |
| 耗时来源 | 迁移事件时间差（phase 级）+ `aws run` 精确计时（执行级） | state 无时间戳；status 调用节奏 = 每 dispatch 批次一次，phase 级粒度够用；执行耗时由真正跑测试的 run 命令给出 |
| 事件流定位 | append-only 审计流；`workflow-state.yaml` 仍是唯一 gate 状态源 | 两者不互为校验依据，避免双源漂移；UI 时间线读 events、当前状态读 state |
| 写失败处理 | stderr warning，**不改变**命令退出码与 stdout | status/gate 的退出码和 JSON 输出是 orchestrator 决策依据，事件是旁路，不能反向影响编排 |

---

## Part 1 — 运行参数落盘（仅改 SKILL.md）

### 改动点

`skills/aws-workflow/SKILL.md`：

1. **initial fields 模板**（L296 `### workflow-state (initial fields)` 附近）新增：

```yaml
# workflow-state.yaml — Phase 1.1 写入，orchestrator-owned
params:                      # resolved runtime parameters（用户覆盖合并默认值后的终值）
  run_mode: full
  test_types: [api, e2e]
  run_tests: true
  max_case_fix_attempts: 2
  max_plan_fix_attempts: 2
  max_healing_attempts: 2
```

2. **Runtime Parameters 章节**（L109-126）加一句：解析完用户覆盖后，终值 MUST 写入
   `workflow-state.yaml.params`；后续所有 `aws status` / `aws gate check` 调用以该块为准。

3. 参数键名与 `workflow-schema.yaml.params` 段一致（引擎按键名匹配覆盖，未知键被忽略）。

### 下游收益

- `aws status` 的 `when` 谓词剪枝与实际执行分支一致（修复上述 bug）。
- UI 判断"要执行哪些类型"的完整链路：
  启动即读 `params.test_types` / `params.run_mode` → Phase 2.5 后读 `layers.*`（权威）。

### 验收

- 以 `test_types=api` 启动 workflow → state 含 `params.test_types: [api]` →
  `aws status --next` 不再推荐 e2e phase（现状会推荐）。
- 不提供覆盖时写入默认值全集，`aws status` 行为与现状一致（回归无变化）。

---

## Part 2 — 结构化事件流 events.jsonl

### 文件与事件模型

路径：`qa/changes/<change-id>/events.jsonl`，append-only，一行一个 JSON 对象。

公共字段：

```jsonc
{
  "seq": 12,                          // 单调递增（写入时 = 现有最大 seq + 1）
  "ts": "2026-07-03T08:00:00.000Z",   // CLI 写入时刻（ISO 8601 UTC）
  "source": "status" | "gate" | "run",
  "type": "...",                      // 见下
  "change_id": "RET-role-management"
}
```

事件类型：

| type | source | 专有字段 |
|------|--------|---------|
| `phase_transition` | status | `phase`, `from`（首见为 `null`）, `to`, `outputs`（schema produces 中已存在的文件）, `duration_ms`（可选；从该 phase 上一次变为 `ready` 到本次观察到完成的近似耗时） |
| `gate_verdict` | gate | `phase`, `gate`, `verdict`, `blocks`（BLOCK finding 数，见下）, `evidence` |
| `execution_start` | run | `targets`（本次执行的层：api/e2e/fuzz/perf） |
| `execution_end` | run | `per_target: { api: {status,total,passed,failed,skipped}, ... }`, `duration_ms` |

`blocks` 派生规则：`gate_verdict` 事件写入时，读取该 phase 在 schema 中声明的 `gate_file`
（如 `review/case-review.json`），统计 `findings[]` 中 `severity == "BLOCK"` 的条数；
文件缺失或解析失败时 `blocks: null`（不阻断事件写入）。

### 新模块 `src/core/events.ts`

```ts
appendEvents(projectRoot, changeId, events: QaEvent[]): void
// O_APPEND 整行单次 write + '\n'；目录不存在时创建；失败仅 stderr warning

readPhaseSnapshot(projectRoot, changeId): Map<string, string>
// 全量扫描 events.jsonl 的 phase_transition，返回 phase → 最后一次 `to`
// 跳过无法解析的行（容忍尾行截断）；文件规模为数百行级，全扫可接受

nextSeq(projectRoot, changeId): number
```

### 埋点 1 — `aws status`（src/commands/status.ts）

`computeStatus` 成功后、输出前：

```
snapshot = readPhaseSnapshot(...)
for phase of report.phases:
    if phase.status == 'pruned': continue          // 剪枝的 phase 不产生事件
    last = snapshot.get(phase.id) ?? null
    if last != phase.status:
        events.push(phase_transition { from: last, to: phase.status, ... })
appendEvents(events)
```

- 首次运行：所有非 pruned phase 各产生一条 `from: null` 的迁移事件，UI 时间线有起点。
- fix loop 的 `done → needs_fix → done` 每次翻转都被 diff 捕获——state 快照表达不了的
  重试历史在这里免费获得。
- 幂等：状态未变则零写入；连续调 status 不刷重复事件。

### 埋点 2 — `aws gate check`（src/commands/gate.ts）

`checkGate` 成功后（L60 之后、输出前）追加一条 `gate_verdict`。每次裁决都记录
（同一 gate 复核产生多条事件，符合审计定位）。

### 埋点 3 — `aws run`（src/commands/run.ts）

`run()` 调用前追加 `execution_start`（记 t0）；返回后追加 `execution_end`
（`duration_ms = now - t0`，`per_target` 从现有 `result.api/e2e/fuzz/performance` 映射）。

### 硬约束

1. 三处埋点全部 **best-effort**：任何写盘异常 → `console.error` 一条 warning，
   命令的退出码、stdout（含 `--json` 输出）保持不变。
2. 事件写入不读不写 `workflow-state.yaml`——所有权边界不变。
3. subagent 权限模型无需扩展：subagent 本就被禁止调用 `aws status/gate`（bash deny），
   events.jsonl 实际写入者只有 orchestrator 触发的 CLI 进程。
   `.opencode/agents/*.md` 可选加一条 `**/qa/changes/**/events.jsonl: deny` 显式化
   （防 subagent 用 write 工具直改）。

### 消费方（信息性，不在本 spec 实现）

openchamber spec WS4 的 `/api/qa/events` SSE 端点从"chokidar watch qa/ 目录推断"升级为
"tail events.jsonl 直读"；Overview 时间线新增每 phase 耗时（相邻迁移事件时间差）与
重试次数（同 phase 迁移事件计数）两个展示维度。

---

## 非目标

- 不新增 `aws events emit` 自定义事件命令（写入模块已具备能力，真有需求再暴露；
  暴露即重新引入 LLM 调用纪律问题，默认不做）。
- 不给 `workflow-state.yaml` 补时间戳（events.jsonl 承担时间维度，state 保持现状）。
- 不回填历史 change 的事件（events.jsonl 缺失时 UI 回退到只读 state 快照）。
- 不做 events → state 的对账兜底（事件发射不依赖 LLM 纪律后，对账失去必要性）。

---

## 实施顺序

| 步骤 | 内容 | 改动面 |
|------|------|--------|
| S1 | SKILL.md `params` 落盘（Part 1） | 仅 `skills/aws-workflow/SKILL.md` 两处 |
| S2 | `src/core/events.ts` + 单测 | 新文件 |
| S3 | status 埋点（快照 diff）+ 单测 | `src/commands/status.ts` |
| S4 | gate / run 埋点 + 单测 | `src/commands/gate.ts`、`src/commands/run.ts` |
| S5 | 文档：README 补 events 契约；实现以 `src/workflow/orchestration/engine.ts` 为准 | 文档 |

S1 独立可发布（并单独修复 status DAG 不一致 bug）；S2-S4 一个批次。

### 测试要点

- events.ts：追加/读快照/坏行容忍/首次运行 seq=1。
- status diff：首次全量 `from:null`；状态未变零写入；fix loop 翻转产生多条事件；
  pruned phase 不产生事件；完成事件在存在上一条 `ready` 记录时带近似 `duration_ms`；
  写盘失败不影响退出码。
- gate：`blocks` 从 review JSON 正确计数；gate_file 缺失时 `blocks:null`。
- run：`per_target` 映射与 `duration_ms` 存在性。

---

## 风险与开放问题

1. **status 从纯查询变为带旁路写入**：违反"查询无副作用"的洁癖。接受理由：事件是
   observability 旁路、失败不影响语义；替代方案（独立 emit 命令）引入更大的
   LLM 纪律风险。如需逃生门，可加 `--no-events` 开关（默认开）。
2. **events.jsonl 与 status 调用节奏耦合**：orchestrator 若在一次迭代里连续完成多个
   phase 才调 status，中间态迁移会被合并成一条（from 直接跳到最终态）。可接受——
   审计粒度 = 编排决策粒度。
3. **params 写入是 LLM 行为**：格式错误时引擎 `isObject` 检查会静默忽略整块。
   可选增强：`aws doctor` 加一条 params 块格式校验（S5 顺手做）。
4. **文件增长**：单 change 生命周期事件量在数百行级，全扫描 diff 可接受；
   不做轮转（change 归档后 events.jsonl 随目录一起进 `qa/archive/`）。
