# Meta-Team 式 Retro 闭环 Spec：执行证据 → 三层改进提案 → 人工 promote → eval 回归

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

**日期**: 2026-07-08
**版本**: v0.2（2026-07-08 review 修订：SUT 外置验证拓扑 §5.1、promote 审计改走 promotions.json、apply_kind→eval 映射、memory 写保护与失效约定、证据 ID 只读归档约束）
**状态**: Draft / 实现-ready
**涉及面（规划）**: `src/commands/retro.ts`（新增）、`src/retro/**`（新增聚合器）、`src/core/events.ts`（复用读取）、`src/cli.ts`（注册命令）、`skills/aws-retro/SKILL.md`（新增）、`.aws/memory/**`（新增经验文件）、`eval/**`（回归验证复用）
**关联设计**:
- [engineering/design/state-machine-enforcement.md](../design/state-machine-enforcement.md)（events.jsonl 事件账本；本 spec 的主要输入源）
- [schemas/workflow-schema.yaml](../../schemas/workflow-schema.yaml)（team-level 提案的修改对象）
- [engineering/design/two-stage-intake-execution.md](../design/two-stage-intake-execution.md)（`data-knowledge.proposal.yaml` 的「提案不改主库、人工 promote」模式，本 spec 与之同构）

**理论支点（见 §9 设计 lineage）**：Meta-Team 三层协作自我演化 → 提案分层；DecentMem 去中心化双池记忆 → `.aws/memory/<skill>.md` 按-skill 拆分（利用池）+ `proposals.json`（探索池）；Skill-MAS 的 SKILL.md 演化 + 对比式反思 → 本项目最直接同构（拟吸收其"高/低轨迹对照"信号）。三者的"自动更新"环节均替换为本项目「人工 promote + eval 回归」安全边界。

---

## 0. 问题与方案映射

### 0.1 缺口

项目已经把「演化 MAS」最贵的三块基建建完——**配置化表示**（schema-as-data + `agent:`/`owned_by`/gates/params）、**确定性执行器**（engine 路由 + `aws state`/`gate` 纯谓词裁决）、**可复现评测器**（eval E0–E4 + baseline）。但**演化循环的驱动器为空**：系统每次 change 都在产出改进所需的全部证据，却没有任何组件消费它们来产生改进。

| 现有证据（已落盘） | 现状消费方 | 缺口 |
|---|---|---|
| `qa/changes/*/events.jsonl`（gate 裁决、heal 流转、human override、失败重分类） | 仅 `aws status`/`audit` 单 change 内消费 | **无跨 change 模式分析** |
| `inspect/failure-analysis.json`（失败分类 + 根因） | 仅当次 healing loop | **不沉淀为「下次别再犯」的规则** |
| `eval/runs/*/metrics.json`（分层指标 + token + wall time） | `eval compare` 仅「当前 vs 基线」两点 | **无趋势归因** |
| `qa/archive/<id>/`（跨 change 历史） | 人工翻阅 | **无自动蒸馏** |

当前知识回流是**纯人工**的：README-EVAL 里 depts 的 `max_length=20`、roles 的 seed 对齐，都是人看到失败后手工补进 SKILL.md 的。

### 0.2 方案一句话

> 新增 `aws retro` 命令（CLI 侧确定性聚合）+ `aws-retro` skill（LLM 侧归因），把 events + failure-analysis + eval 趋势聚合成 `retro/context.json`，据此按 **Meta-Team 三层**（agent / interaction / team）输出 `retro/proposals.json`；提案**只写文件、绝不直接改** SKILL.md / schema，人工 promote 后跑对应 eval suite 与 baseline 对比，无回归才合入。

**核心约束（与 `data-knowledge.proposal.yaml` 完全同构）**：retro 只生产提案，永不直接改配置。演化慢一点，但每步都有 eval 证据 + 人工签字——这是 Meta-Team「team constitution」层的工程化等价物。

**验收总标准**：给定 ≥3 个已归档 change，`aws retro --since <date>` 能产出带证据引用的三层提案；每条 agent-level 提案落点是某个 `.aws/memory/<skill>.md`；每条 team-level 提案可机械应用为 schema diff 并由指定 eval suite 验证；无任何提案自动改动 SKILL.md / schema / 主知识库。

---

## 1. 数据流总览

```text
[已存在，零新增采集]
qa/changes/*/events.jsonl ─┐
inspect/failure-analysis.json ─┤
eval/runs/*/metrics.json ─┤
qa/archive/<id>/ ─┘
        │
        ▼  机制 A：CLI 确定性聚合（aws retro，纯 TS，不含 LLM）
retro/context.json  ← 统计事实 + 证据 ID
        │
        ▼  机制 B：LLM 归因（aws-retro skill）
retro/proposals.json  ← 三层提案，每条引用 ≥1 证据 ID
        │
        ▼  机制 C：人工 promote（复用现有安全边界）
  ├─ agent-level      → 应用到 .aws/memory/<skill>.md
  ├─ interaction-level → 应用到 artifact 契约（review JSON schema / SKILL.md 契约段）
  └─ team-level        → 应用到 schemas/workflow-schema.yaml
        │
        ▼  机制 D：eval 回归
eval run <对应 suite> + eval compare --baseline main  → 无回归才合入
```

职责边界沿用项目既有分工：**CLI 只算不判断价值，Skill 只提议不落地，人工只审批采纳，eval 只验证不放行**。

---

## 2. 机制 A：`aws retro` 聚合器（确定性，无 LLM）

### 2.1 命令契约

```bash
aws retro --since <ISO-date> [--json] [--out <path>]
aws retro --change <id> [--change <id> ...]
```

| 参数 | 含义 |
|---|---|
| `--since <ISO>` | 扫描 `qa/archive/` 下 `archived_at >= since` 的所有 change（默认最近 30 天） |
| `--change <id>` | 限定单个/多个 change（可重复）；与 `--since` 互斥 |
| `--out <path>` | `context.json` 输出路径（默认 `qa/retro/<retro-id>/context.json`） |
| `--json` | 输出 `{ retro_id, change_count, signal_count }`（`signal_count` = `signals` 各数组条目数之和，`healing_efficiency` 计 1） |

**运行位置**：与 `aws run`/`aws status` 相同，cwd = 被测项目根（真实用户项目，或 eval 场景下的 SUT checkout）。`qa/archive/`、`qa/retro/` 均相对该根解析。

**只消费已归档 change**：`--change` 指向未归档 change 时报错。理由：`fail-<N>` 证据 ID 索引 `failure-analysis.json`，该文件在 healing 过程中会被 inspect 重写，只有 `qa/archive/` 下的冻结副本才保证证据 ID 稳定。**只读**：retro 聚合器绝不修改任何 change 产物。

### 2.2 输入解析（全部现成文件）

- `events.jsonl`：用 `readEvents()`（`src/core/events.ts`）逐 change 读取，关注事件类型：
  - `gate_verdict`（`verdict`、`gate`、`phase`、`blocks`）→ 门打回频率与原因分布
  - `heal_transition`（`from`/`to`）+ `heal_record_apply`（`applied_proposals`/`skipped_proposals`）→ healing 效率
  - `human_override`（`phase`/`action`/`reason`）→ 人对自动裁决的不信任点
  - `failure_reclassified`（`from`/`to`/`evidence`）→ 分类器系统性偏差
- `inspect/failure-analysis.json`：失败分类分布、`fix_proposal_eligible` 命中率
- `eval/runs/*/metrics.json`：按 suite 聚合指标趋势（可选，缺失则跳过该维度）

### 2.3 输出：`retro/context.json`（确定性统计事实）

```json
{
  "retro_id": "retro-20260708-ab12cd",
  "generated_at": "2026-07-08T00:00:00Z",
  "window": { "since": "2026-06-08", "change_count": 5, "change_ids": ["..."] },
  "signals": {
    "failure_distribution": [
      { "category": "test_data_failure", "count": 7, "changes": ["RET-a","RET-b"],
        "top_modules": ["depts","menus"], "evidence_ids": ["RET-a#fail-3","RET-b#fail-1"] }
    ],
    "gate_pushback": [
      { "gate": "api-plan-review-gate", "verdict": "needs_fix", "count": 4,
        "top_reasons": ["assertion_traceability missing"], "evidence_ids": ["RET-a#seq12"] }
    ],
    "healing_efficiency": {
      "entered": 6, "resolved_round1": 4, "resolved_round2": 1, "exhausted": 1,
      "no_op_rate": 0.17, "evidence_ids": ["RET-c#seq30"]
    },
    "human_overrides": [
      { "phase": "e2e-plan-review", "action": "fix_and_proceed", "count": 2,
        "reason_summary": "fixer 拒绝 high severity", "evidence_ids": ["RET-d#seq24"] }
    ],
    "reclassifications": [
      { "from": "assertion_failure", "to": "assertion_expectation_error", "count": 3,
        "evidence_ids": ["RET-e#seq41"] }
    ],
    "eval_trend": [
      { "suite": "workflow-api-codegen", "metric": "test_executable_rate",
        "recent": 0.92, "baseline": 0.97, "delta": -0.05 }
    ]
  }
}
```

`eval_trend.recent` 口径：该 suite 窗口期内（`--since` 起）**最近 5 个 run 的中位数**；不足 5 个取全部；`baseline` 取 `eval/baselines/main.json` 中该 suite 对应指标。窗口内无 run 则省略该 suite 条目。

**证据 ID 规范**：`<change-id>#<locator>`，locator 为 `seq<N>`（events 序号）/ `fail-<N>`（failure-analysis 索引）/ `run:<run-id>`（eval run）。所有下游提案必须引用此处已存在的 ID，不得杜撰。

---

## 3. 机制 B：`aws-retro` skill（LLM 归因，三层提案）

### 3.1 输入 / 输出

- 输入：`retro/context.json`（唯一事实源）+ 只读访问 `.aws/memory/**`、`schemas/workflow-schema.yaml`、相关 `skills/*/SKILL.md`
- 输出：`retro/proposals.json` + `retro/retro-summary.md`（人类可读）
- 禁止：直接修改任何 SKILL.md / schema / memory / 主知识库（与 reviewer「只读」、fixer「只改授权范围」同一纪律）

### 3.2 三层提案映射

| Meta-Team 层 | 提案对象 | 触发信号（来自 context.signals） | 落点 |
|---|---|---|---|
| **agent-level** | 单个 skill 的经验规则 | `failure_distribution` 中某类失败在同一 skill 反复出现 | `.aws/memory/<skill>.md`（机制 C-1） |
| **interaction-level** | artifact 契约 | `gate_pushback` 反复因同一字段缺失打回；`human_override` 因契约僵局 | review JSON schema / SKILL.md 的 Output Contract 段 |
| **team-level** | schema 阶段/gate/参数 | `healing_efficiency`（如第 2 轮修复率极低）、`reclassifications`（分类器偏差） | `schemas/workflow-schema.yaml` |

### 3.3 `retro/proposals.json` 结构

```json
{
  "retro_id": "retro-20260708-ab12cd",
  "proposals": [
    {
      "id": "RETRO-001",
      "layer": "agent",
      "target": ".aws/memory/aws-api-codegen.md",
      "problem": "depts 模块连续 2 个 change 因 name 超 ORM max_length=20 造数失败",
      "evidence_ids": ["RET-a#fail-3", "RET-b#fail-1"],
      "proposed_change": "追加造数规则：dept name 前缀 ≤11 字符 + 8 位 hex（unique_dept_name）",
      "apply_kind": "memory_append",
      "eval_suite": "workflow-api-codegen",
      "risk": "low",
      "confidence": "high",
      "status": "proposed"
    },
    {
      "id": "RETRO-002",
      "layer": "team",
      "target": "schemas/workflow-schema.yaml#loops.healing.max_param",
      "problem": "healing 第 2 轮修复率仅 8%，多数 change 第 1 轮即 resolved 或直接 exhausted",
      "evidence_ids": ["RET-c#seq30", "RET-c#seq38"],
      "proposed_change": "max_healing_attempts 默认 2 → 1（省 token，暴露真 bug 更快）",
      "apply_kind": "schema_param",
      "eval_suite": "workflow-full",
      "risk": "medium",
      "confidence": "medium",
      "status": "proposed"
    }
  ]
}
```

规则：
- 每条提案 `evidence_ids` 必须 ≥1 且全部存在于 `context.json`；无证据 → 不得生成（对齐 explore「no evidence → 不写 hint」）。
- `status ∈ {proposed, promoted, rejected, needs_rework}`——生成时恒为 `proposed`；后三态由人工在 promote 环节更新（见 §4 promotions.json）。
- `risk = high` 的 team-level 提案（改 gate 语义 / 阶段结构）必须 `confidence` 与证据齐全，且强制 `eval_suite: workflow-full`。

**`apply_kind` → promote 方式与 eval 验证强度（完整映射）**：

| apply_kind | 层 | promote 应用方式 | eval 验证要求 |
|---|---|---|---|
| `memory_append` | agent | 追加 `.aws/memory/<skill>.md` 条目 | 对应单层 suite（E2*），经 §5.1 seed 机制注入后跑 |
| `contract_field` | interaction | 契约**两端同一 PR 原子更新**（reviewer 的 review JSON schema + 消费方 SKILL.md Output Contract 段） | 跑**覆盖该 phase 对的完整 suite**（如 api 契约 → `workflow-api-codegen`，其流水线同时经过 plan-review 与 codegen 两端）；跨层契约跑 `workflow-full` |
| `schema_param` | team | `workflow-schema.yaml` params/loops 机械 diff | 受影响 phase 所属 suite；healing/全局参数 → `workflow-full` |
| `schema_structure` | team | 增删 phase / 改 gate 谓词 | 强制 `workflow-full`（E4）+ 人工重点审阅拓扑 |

---

## 4. 机制 C：人工 promote（复用现有安全边界）

### C-1. agent-level → `.aws/memory/<skill>.md`（DecentMem 式分布式经验）

- **归属**：`.aws/memory/` 是**被测项目侧**产物（与 `.aws/config.yaml` 同级，per-project）——经验多为 SUT/项目特定（如 depts 的 `max_length=20`），不进 skills 主仓。
- 每个 codegen/plan/inspect skill 对应一个 `.aws/memory/<skill>.md`，**只由该 skill 在运行时加载**（避免经验错位加载浪费 token，也解决 SKILL.md prose 膨胀）。
- 结构：`## 经验条目` 列表，每条含 `来源 change / 证据 ID / 规则 / 生效日期 / 来源上下文`（eval 场景含 SUT `pinned_sha`）。
- promote = 人工把 `RETRO-*`（`apply_kind: memory_append`）的 `proposed_change` 追加进对应文件；memory 文件本身不进 gate，是软经验。
- skill 侧改动（实现期一次性完成，非 retro 动作）：各目标 skill 的 SKILL.md 加一行「运行前读取 `.aws/memory/<self>.md`（若存在）」。
- **写保护**：memory 会被自动注入 skill prompt，是新的注入面。`.aws/memory/**` 必须列入 write-scan / forbidden-write 保护路径——运行期任何 agent/生成代码写入即违规，唯一合法写入方是人工 promote。
- **失效与清理**：经验条目随环境漂移会过期（如 SUT 升级后 ORM 约束变化）。约定：eval 场景下 `suts.yaml.pinned_sha` 升级时，**人工复审所有标注旧 pin 的条目**，过期条目标 `deprecated: <日期>`（保留供审计，加载时跳过）。真实项目场景由 retro 自身闭环发现：失效经验会重新以失败信号出现在下一轮 `context.json`。

### C-2. interaction-level → artifact 契约

- 应用为 review JSON schema 或 SKILL.md「Output Contract」段的 diff（如给 `api-plan-review.json` 加必填字段）。
- 必须同时更新对应 reviewer skill 与消费方 codegen skill，保持契约两端一致。

### C-3. team-level → `workflow-schema.yaml`

- `schema_param`：改 `params` 默认值 / `loops.*.max_param`，机械 diff。
- `schema_structure`：增删 phase / 改 gate 谓词，需人工重点审阅（可能影响拓扑）。

**统一纪律**：三类 promote 全部人工执行；retro 产物只是 diff 建议。

**promote 审计（不新增事件类型）**：promote/reject 决定写入 `qa/retro/<retro-id>/promotions.json`（`{ proposal_id, decision, decided_by, decided_at, eval_run_id }`），并同步更新 `proposals.json` 对应条目的 `status`。审计走该文件 + git commit，**不**写入 `events.jsonl`——与 §8「不改采集层」保持一致（events.jsonl 只记 workflow 运行期事件）。

---

## 5. 机制 D：eval 回归验证

promote 前对每条被采纳提案：

```bash
npm run build
node dist/cli.js eval run --suite <proposal.eval_suite> --fail-on-verdict
node dist/cli.js eval compare --baseline main --run <run-id>
```

- 无回归（关键 hard gate 不降级）才允许合入；有回归 → 提案退回或标记 `needs_rework`。
- team-level `risk: high` 强制跑 `workflow-full`（E4）；agent-level 可只跑对应 codegen suite（E2*），成本低。
- 评测成本现实约束：真实 LLM 全流程 10–30 分钟/样本，故 retro **不做自动搜索**，只做「人工选提案 → 单点回归」。种群/搜索留给后续 EvoMAS/AFlow 阶段（本 spec 非目标）。

### 5.1 SUT 外置后的验证拓扑（与 [2026-07-08-sut-extraction-spec](2026-07-08-sut-extraction-spec.md) 的交互）

SUT 外置后，`qa/changes/`、`qa/archive/`、`.aws/memory/` 在 eval 场景下全部位于**外部 SUT checkout**（`{{sut.dir}}`，被 `eval/suts.yaml` pin 住 SHA）。由此约定：

| 提案层 | 修改对象所在仓 | eval 验证方式 |
|---|---|---|
| agent（memory） | 被测项目侧（真实项目或 SUT checkout） | **不改 pinned SUT 仓**：候选经验条目经 `eval-seed-change.mjs` fixture tier 机制 seed 进 `{{sut.dir}}/.aws/memory/<skill>.md`（工作区写入，与现有 qa/changes seed 同性质，不产生 SUT commit），然后跑 suite |
| interaction / team（契约、schema） | skills 主仓 | 直接在主仓分支改动后跑 suite，无 SUT 交互 |

promote 的双落点（agent-level）：
1. **真实用户项目**：直接写入该项目的 `.aws/memory/<skill>.md`（该项目自己的 git 管辖）。
2. **eval golden 路径**（若该经验应成为 eval 基线行为的一部分）：将条目加进主仓 `eval/fixtures/` 对应 tier，由 seed 机制在每次 eval run 时注入——**而非** commit 进 SUT 仓（避免触发 `pinned_sha` 升级 + golden 全量复审的重流程）。

只有当经验本质上属于 SUT 自身缺陷修复（改 SUT 代码而非测试经验）时，才走 SUT 仓 commit + pin 升级通道，那是 SUT extraction spec §1 的 pin 纪律管辖范围，不属于 retro。

---

## 6. 数据与文件落点小结

以下路径均相对**被测项目根**（见 §2.1 运行位置）：

| 文件 | 生产者 | 性质 |
|---|---|---|
| `qa/retro/<retro-id>/context.json` | `aws retro`（CLI） | 确定性统计，只读输入的聚合 |
| `qa/retro/<retro-id>/proposals.json` | `aws-retro`（skill） | LLM 提案，不落地；`status` 由 promote 更新 |
| `qa/retro/<retro-id>/promotions.json` | 人工 promote | 采纳/拒绝审计记录（§4 统一纪律） |
| `qa/retro/<retro-id>/retro-summary.md` | `aws-retro`（skill） | 人类可读 |
| `.aws/memory/<skill>.md` | 人工 promote（唯一合法写入方） | 分布式软经验，对应 skill 加载；write-scan 保护 |

---

## 7. 实施阶段（估计 1–2 周）

| 步 | 内容 | 产物 | 估时 |
|---|---|---|---|
| ① | `src/retro/` 聚合器 + `aws retro` 命令 + 注册 | `context.json` 可生成 | ~2 天 |
| ② | `skills/aws-retro/SKILL.md`（三层提案格式 + 证据引用规则） | `proposals.json` 契约 | ~2 天 |
| ③ | `.aws/memory/<skill>.md` 机制 + 各目标 skill 加载行 | agent-level 落点 | ~1 天 |
| ④ | promote 约定文档 + eval 回归接线 + 单测 | 闭环打通 | ~2 天 |

单测建议：聚合器对固定 fixture events 产出稳定 `context.json`（快照测试）；提案 schema 校验；证据 ID 存在性校验（杜绝杜撰）。

---

## 8. 非目标（明确排除）

- **不做自动搜索 / 变体演化**：schema variant、多变体 compare、successive-halving 属于后续 EvoMAS/AFlow 阶段。
- **不做 meta-agent 从零生成 MAS**：团队结构由 QA 领域固定，不需要 EvoAgent/ADAS 式发明团队；且 ADAS 执行 untrusted 生成代码与项目安全门冲突。
- **不自动改配置**：任何 SKILL.md / schema / 主知识库变更一律经人工 promote。
- **不改采集层**：所有输入均为现有产物，本 spec 不新增 `events.jsonl` 事件类型或 workflow 阶段（promote 审计走 `promotions.json` 文件，见 §4）。
- **不做 memory 自动淘汰**：经验条目的失效依赖 §C-1 的 pin 升级人工复审 + retro 下一轮失败信号自证，不做在线权重衰减。

---

## 9. 设计 lineage：理论支点与机制对照

本 spec 不是凭空设计，而是把三条 MAS 自我演化的学术思路（Meta-Team、DecentMem、Skill-MAS）裁剪到本项目「确定性执行 + 人工把关 + eval 回归」的工程约束下。本章记录理论来源、其核心机制、以及**本项目已具备/尚缺**的对照——即为什么 retro 闭环是「差最后一块」而非「从零造」。

### 9.1 Meta-Team：三层协作自我演化 → L1/L2/L3 反思闭环

> **引用**：代码仓 [`zz-haooo/Meta-Team`](https://github.com/zz-haooo/Meta-Team)。⚠️ arXiv 号待核——用户提供的 `arxiv.org/pdf/2605.22721` 经查实为 DecentMem 那篇（见 §9.2），与 Meta-Team 不符；本节的三层机制描述基于对该框架的定性理解，具体论文细节以官方仓/正式论文为准。

**理论机制**：Meta-Team 把多智能体系统的自我演化拆到三个正交层面，每层各有一个「执行 → 反思 → 更新」的回路，避免把所有改进都塞进单一的 prompt 微调：

| 层 | Meta-Team 关注点 | 反思对象 | 演化产物 |
|---|---|---|---|
| **L1 agent-level** | 单个 agent 的能力 | 该 agent 自己的成败轨迹 | 个体经验 / 能力更新 |
| **L2 interaction-level** | agent 之间的协作协议 | 交接点的信息损耗、误解、返工 | 通信/交接契约调整 |
| **L3 team-level** | 团队构成与流程拓扑 | 全局效率、瓶颈、冗余环节 | 角色/阶段/编排结构调整 |

关键洞察是**分层归因**：一个失败若源于「某 agent 造数不当」（L1）、「reviewer 与 codegen 对字段理解不一致」（L2）、还是「healing 轮次设置不合理」（L3），修复落点完全不同。混为一谈会导致「改了 prompt 但结构性问题依旧」。

**本项目对照**：

| Meta-Team 要素 | 本项目已具备 | 本项目尚缺（本 spec 补齐） |
|---|---|---|
| 执行轨迹 | `events.jsonl`（gate 裁决 / heal 流转 / human override / 重分类） | — |
| 失败根因 | `inspect/failure-analysis.json`（分类 + 根因） | — |
| 运行时 agents | engine 路由的各 skill（`agent:`/`owned_by`） | — |
| **L1/L2/L3 反思回路** | ❌ 无组件消费上述证据产生分层改进 | ✅ §2 聚合信号 + §3.2 三层提案映射 |

映射关系（本 spec §3.2 即 Meta-Team 三层的工程化实例）：
- **L1 → agent-level 提案**：`failure_distribution` 中某类失败在同一 skill 反复出现 → 落 `.aws/memory/<skill>.md`。
- **L2 → interaction-level 提案**：`gate_pushback` 反复因同一字段缺失打回、或 `human_override` 因契约僵局 → 落 artifact 契约（review JSON schema / SKILL.md Output Contract 段）。这正是 Meta-Team 的「交接点信息损耗」在本项目的可观测代理——gate 就是 agent 间的显式交接检查点。
- **L3 → team-level 提案**：`healing_efficiency` / `reclassifications` 暴露流程结构问题 → 落 `workflow-schema.yaml`（阶段 / gate / params）。

**本项目的保守化裁剪**：Meta-Team 的三层反思是**自动闭环**（反思即更新）；本 spec 在每层的「更新」前强制插入**人工 promote + eval 回归**（§4、§5）。原因：QA 领域的错误改进会直接放行坏测试，代价不可逆,因此用 `data-knowledge.proposal.yaml` 同构的「提案不落地」纪律换取可审计性。这是把 Meta-Team 的「team constitution」层显式工程化为「人工签字 + eval 证据」。

### 9.2 DecentMem：去中心化双池记忆 → 按-skill 拆分的 `.aws/memory/`

> **引用**：Guangya Hao, Yunbo Long, Zhuokai Zhao. *Self-Evolving Multi-Agent Systems via Decentralized Memory*. [arXiv:2605.22721](https://arxiv.org/abs/2605.22721)（2026-05-21）。官方 GitHub 暂未稳定核到。

**理论机制**（按论文摘要校准）：DecentMem 反对「所有 agent 共享一个中心化记忆库」——中心化会带来通信/协调开销、隐私问题，并**抹平 agent 多样性**（diversity collapse）。方案是**去中心化**：每个 agent 维护**自己的双池记忆**：
1. **exploitation pool（利用池）**：已固化的过往轨迹（consolidated past trajectories）——即"验证过、可复用"的经验。
2. **exploration pool（探索池）**：LLM 为**未见过的上下文**生成的候选经验（LLM-generated candidates for unseen contexts）——即"还没验证、待试"的假设。

两池由 **LLM-as-a-judge 的阶段性反馈在线重加权**（online reweight）；论文并证明该设计保证解空间全局可达且累积 regret 为 $O(\log T)$，匹配随机 bandit 下界。经验上跨 AutoGen / DyLAN / AgentNet 三框架，较最强中心化记忆基线最高提升 23.8% 准确率、省 token 最高 49%。

**本项目对照**（双池 = 已 promote 的经验 vs 待验证的提案）：

| DecentMem 要素 | 本 spec 落点 |
|---|---|
| 去中心化（per-agent memory） | `.aws/memory/<skill>.md` 一个 skill 一个文件，**只由该 skill 运行时加载**（§C-1） |
| 保 agent 多样性 / 免干扰 | `api-codegen` 运行时不加载 `e2e-plan` 的经验，避免 diversity collapse 与 token 稀释 |
| **exploitation pool（利用池）** | `.aws/memory/<skill>.md` 中**已 promote 且过 eval 回归**的经验条目——固化轨迹 |
| **exploration pool（探索池）** | `retro/proposals.json` 中**尚未 promote** 的候选规则——针对新出现失败模式的假设 |
| 池间流转 | 候选从探索池 → 利用池的唯一通道是**人工 promote + eval 回归**（§4/§5），而非在线运行 |

**本项目的关键裁剪**：DecentMem 用 **LLM-as-judge 在线重加权**在两池间自动流转；本 spec **换成离线的 eval 回归 + 人工 promote**。理由同 §9.1——QA 领域「错误经验固化 = 放行坏测试」不可逆，故不允许运行时自动把探索池经验升为利用池。代价是失去 DecentMem 的 $O(\log T)$ 在线收敛速度，换来每次固化都有 eval 证据 + 审计链。

**为什么按 skill 拆而非单一 memory**：本项目 skill 数量已达 20+（case-design / api-plan / e2e-codegen / inspect …），共用一份经验库正是 DecentMem 批判的中心化反模式。按 skill 拆分直接实现「只加载相关记忆」，并顺带解决 SKILL.md prose 随经验膨胀——软经验进 `.aws/memory/`，SKILL.md 保持稳定契约。

### 9.3 Skill-MAS：SKILL.md 演化 + 对比式反思（最直接同构）

> **引用**：Hehai Lin, Qi Yang, Chengwei Qin. *Skill-MAS: Evolving Meta-Skill for Automatic Multi-Agent Systems*. [arXiv:2606.18837](https://arxiv.org/abs/2606.18837)（2026）。代码 [`linhh29/Skill_MAS`](https://github.com/linhh29/Skill_MAS)。

Skill-MAS 是这批工作里与本项目**载体完全一致**的一篇——它演化的就是 `SKILL.md` 文本本身。其单轮演化：

1. **多轨迹 rollout**：同一任务跑 `k` 条轨迹，agent 读当前 `SKILL.md` 生成并执行 MAS，记录分数 + 阶段级 trace。
2. **对比式反思（contrastive reflection）**：对比**高分 vs 低分**轨迹，合成结构化改进信号。
3. **skill bank 优化**：optimizer LLM 依据反思报告重写 `SKILL.md`。
4. **轮次选择**：跨轮记录分数，选最优 skill 快照。

**对本 spec 的两点启发**：

| Skill-MAS 机制 | 本 spec 现状 / 可吸收点 |
|---|---|
| **对比式反思**（高分 vs 低分轨迹对照） | 本 spec §2 聚合器目前只做**失败分布**（低分侧），**未做高/低对照**。可吸收：`context.json` 增加"通过 change vs 打回 change 的差异信号"，让 L1/L2 提案不只"避免失败"，还能"复制成功模式"。**这是本 spec 的一个明确改进方向。** |
| optimizer LLM **自动重写 SKILL.md** | 本 spec **刻意不做**——SKILL.md 是稳定契约，只经人工 promote 改；软经验走 `.aws/memory/`。 |
| 演化**单个** meta-skill（从零生成 MAS 团队） | 本项目团队结构由 QA 领域固定（属 §8 非目标），不采用；我们是**多 skill 固定编队**，演化的是各 skill 的经验与交接契约，非团队本身。 |

即：Skill-MAS 验证了"从轨迹反思重写 skill 文本"这条路可行，本 spec 借其**对比式反思**思路，但拒绝其**自动重写 + 从零生成团队**。

### 9.4 lineage 小结：借什么、不借什么

| 维度 | 借鉴来源 | 本项目替换/收紧 |
|---|---|---|
| 改进分层 | Meta-Team L1/L2/L3 三层归因 | 直接采用（§3.2） |
| 记忆结构 | DecentMem per-agent + 双池（利用/探索） | 直接采用（`.aws/memory/` = 利用池，`proposals.json` = 探索池） |
| 反思方式 | Skill-MAS 对比式反思（高分 vs 低分） | **部分吸收**（§9.3：拟增高/低对照信号，当前仅失败分布） |
| 更新方式 | Meta-Team/DecentMem 自动闭环、Skill-MAS 自动重写 skill | **换成**人工 promote + eval 回归 |
| 池间流转 / 记忆写入 | DecentMem LLM-judge 在线重加权 | **换成**离线 eval 回归 + 人工签字 |
| 搜索 / 变体 / 从零生成团队 | EvoMAS 配置池演化、AFlow MCTS、Skill-MAS 3 阶段生成 | **不借**，留给后续阶段（§8 非目标） |

一句话：**分层（Meta-Team）+ 记忆双池（DecentMem）+ 对比反思（Skill-MAS）三处照搬洞察，但把它们的「自动更新/自动重写/在线重加权」统一换成项目既有的「提案—审批—eval 回归」安全边界**。这样 retro 闭环继承了学术核心洞察,又不违反 QA 领域「错误改进不可逆」的工程约束。

### 9.5 参考文献

| 简称 | 论文 / 作者 | 出处 | 代码 |
|---|---|---|---|
| Skill-MAS | Lin, Yang, Qin, *Skill-MAS: Evolving Meta-Skill for Automatic Multi-Agent Systems* | [arXiv:2606.18837](https://arxiv.org/abs/2606.18837) (2026) | [linhh29/Skill_MAS](https://github.com/linhh29/Skill_MAS) |
| DecentMem | Hao, Long, Zhao, *Self-Evolving Multi-Agent Systems via Decentralized Memory* | [arXiv:2605.22721](https://arxiv.org/abs/2605.22721) (2026) | 暂未稳定核到 |
| Meta-Team | 作者/arXiv 待核 | ⚠️ 用户给的 2605.22721 实为 DecentMem，待核 | [zz-haooo/Meta-Team](https://github.com/zz-haooo/Meta-Team) |
| EvoMAS | Hu, Zhang, Trager, Zhang, Yang, Xia, Soatto, *Evolutionary Generation of Multi-Agent Systems* | ICML 2026 | [amazon-science/EvoMAS](https://github.com/amazon-science/EvoMAS) |
| AFlow | Zhang et al., *AFlow: Automating Agentic Workflow Generation* | [arXiv:2410.10762](https://arxiv.org/abs/2410.10762), ICLR 2025 Oral | [FoundationAgents/AFlow](https://github.com/FoundationAgents/AFlow) |
