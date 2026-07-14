# 三问题稳定性方案 Spec：反问模式 + healing 状态机强制 + gate provenance

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

**日期**: 2026-07-04
**版本**: v1.0
**状态**: Implemented（问题 1 完整；问题 2、3 CLI + 审计已落地；SKILL 已同步）
**涉及面**: `src/core`、`src/commands/{state,status,gate,run}.ts`、`src/orchestration/engine.ts`、`schemas/`、`skills/aws-{workflow,intake,execute,explore,case-design}` 及 4 个 fixer skill
**关联设计**:
- [engineering/design/two-stage-intake-execution.md](../design/two-stage-intake-execution.md)（问题 1 架构决策）
- [engineering/design/state-machine-enforcement.md](../design/state-machine-enforcement.md)（问题 2、3 架构决策）

本 spec 是两份设计文档的**实现规格合并视图**：字段、命令签名、错误码、验收标准、实施顺序。架构理由见设计文档，此处不重复论证。

---

## 0. 问题与方案总映射

来自 `RET-api-management` 一次 full 执行的三个实测问题：

| # | 问题 | 根因 | 方案 | 实现状态 |
|---|---|---|---|---|
| 1 | `aws-explore` 无反问直接接续执行 | 模式期望错配 + auto 决策不透明 | 模式选择（`aws-workflow` = autonomous / `aws-intake`+`aws-execute` = interactive）+ `run_context` 传播 + advisory validator 强制 | ✅ 已实现（见 §1，残留 1 项见 §1.4） |
| 2 | healing 状态从不流转（跳过 fix-proposal/fixer、手动改测试、status 停 pending、attempts 空） | `healing.status` 无 CLI 写入口、无消费端前置检查 | `aws state heal` 迁移矩阵 + `aws run` 前置检查 + status 一致性审计 | ⏳ 待实现（见 §2） |
| 3 | `needs_human_review` STOP 后：fixer 正确拒绝 → orchestrator 手改 plan + 手写 review JSON 为 pass | 人工批准无落盘路径 + gate 产物零 provenance | `aws decide` + fixer human-approved 分支 + gate hash 入账 + verdict 迁移审计 | ⏳ 待实现（见 §3） |

**总验收标准**：重演 RET-api-management 的三条事故路径，问题 1 的路径变为合法模式行为（透明留痕），问题 2、3 的抄近路在**下一次 `aws status` 或 `aws run`** 被机械拦截——而不是 archive 末端。

---

## 1. 问题 1 — 反问模式（已实现，登记规格）

### 1.1 已落地的机器规格

**`run_context`（`workflow-state.yaml` 顶层，仅 CLI 写入）**

```yaml
run_context:
  orchestrator_skill: aws-workflow | aws-intake | aws-execute
  interaction_mode: autonomous | interactive     # 派生，非用户参数
  active_scope: full | intake | execute
  stamped_at: <ISO 8601>
```

- 写入命令：`aws state configure --change <id> --orchestrator <skill>`（`src/commands/state.ts`）
- 派生矩阵 + run_mode 合法组合校验：`src/core/workflow_state.ts`（非法组合 hard error，如 `aws-intake + codegen-only`）

**引擎 scope 剪枝（`src/orchestration/engine.ts`）**

- `PhaseStatusKind` 含 `out_of_scope`；produces 未齐且不在 `active_scope` → `out_of_scope`，不进 `next`
- **done 优先**：produces 齐者照常评估 done，跨 scope 依赖（execute 读 intake 的 case-review）由此满足
- terminal `completed` 按 in-scope phase 计算
- `owned_by` 进 `workflow-schema.yaml` 每个 phase；`validateSchema` 校验 enum ⊆ {full, intake, execute}

**advisory OQ 生命周期（`schemas/explore-advisory.schema.json` + `src/risk/validate_advisory.ts`）**

| 字段 | enum / 约束 |
|---|---|
| `status` | `unanswered / answered / deferred` |
| `assertion_intent` | `assert_ideal / assert_known_bug / ignore / undecided` |
| `answered_via` | `explore / auto_default / aws-intake` |
| 一致性 | `answered` → intent + via 必填；`deferred` → `deferred_reason` 必填；`unanswered` → intent/via 必空 |
| 传播 | `answered`（含 `auto_default`）必须传播进 `priority_hints[].assertion_intent` + `open_question_ref` |
| 低置信必问 | `confidence <= medium` 且 hint 含断言方向 → 必须有 linked OQ，否则 validator error |

**mode-aware skill 行为**

| skill | autonomous | interactive |
|---|---|---|
| `aws-explore` Step 5 | auto_default（ideal-behavior → `assert_ideal`，无法判定 → `undecided`），不问 | 逐坑一问；跳过 → `deferred` |
| `aws-case-design` | 不澄清、不要批准；直接生成，`proposal.md` 标 `generation_mode: autonomous`；unanswered OQ → STOP | 保留 8 类澄清 + Step 7 批准 |
| release gate | 恒为 `aws-case-reviewer` 的 `case-review.json`（两种模式一致） | 同左 |

**`aws-execute` preflight**：`case-review.json` pass + advisory 无 unanswered + `cases/` 非空，否则 STOP 指引回 `aws-intake`。

### 1.2 已通过的验收

- 全量测试 32 suites / 288 tests 通过；`tsc --noEmit` 干净
- engine：intake scope 下 `fact-baseline` 为 `out_of_scope` 且不进 next；execute scope 下已 done 的 case-review 满足依赖
- validator：auto_default 未传播 → error；deferred 缺 reason → error；低置信断言 hint 无 linked OQ → error
- state：非法 orchestrator×run_mode 组合 → throw

### 1.3 `aws status` 可观测面（已实现）

```text
Run      : aws-intake / interactive / intake
Questions: 4 total, 2 answered, 1 deferred, 1 unanswered
```

JSON 输出含 `run_context` 与 `intake.open_questions` 汇总。

### 1.4 残留项（本 spec 收编为 P1-R1）

**P1-R1 mode 一致性校验**（two-stage 设计 §10.3，未实现）：
`autonomous` run（`run_context.interaction_mode == autonomous`）下，advisory 中任何 `answered_via ∈ {explore, aws-intake}` 的 OQ → error（防伪造"用户已确认"）。落点：`validate_advisory.ts` 增加可选 `run_context` 入参，或 `aws gate check` 层校验。验收：autonomous state + `answered_via: aws-intake` 的 advisory → 校验失败。

---

## 2. 问题 2 — healing 状态机 CLI 化（待实现）

设计依据：state-machine-enforcement §4。

### 2.1 新命令 `aws state heal`

```bash
aws state heal --change <id> --to proposal_created|applied|resolved|exhausted|not_needed|failed|skipped
```

迁移矩阵（CLI 内唯一持有；违反 → exit 1 + `HEAL-TRANSITION-ILLEGAL`）：

| from → to | 前置校验（缺一 hard error） |
|---|---|
| `pending → proposal_created` | `healing/fix-proposal.json` 存在且 schema 有效；append `healing.attempts[]` 新元素 |
| `pending → not_needed` | 最新 failure-analysis 无 `fix_proposal_eligible` 失败，或 fix-proposal `eligible_count == 0` |
| `pending → skipped` | `gates.healing_available == false` 或 `max_healing_attempts == 0` |
| `proposal_created → applied` | ≥1 份 apply-summary 存在；每份 `files_modified` 非空或 `no_op: true`；`healing/fixer-safety-check.json.passed == true` |
| `proposal_created / applied → failed` | fixer-error 文件存在（`healing/*-fixer-error.json`） |
| `applied → resolved` | healing-rerun + healing-reinspect 均 done；最新 failure-analysis 无 eligible 失败且 `source_batch_id` == 最新 execution batch |
| `applied → exhausted` | `len(attempts) >= max_healing_attempts` 或全部 fixer no_op |
| 其余（含 `pending → resolved`） | `HEAL-TRANSITION-ILLEGAL` |

副作用：更新 `phases.healing.status`；append `heal_transition` 事件（events.jsonl，新事件类型）；`resolved/exhausted` 时回填当前 attempt 的 `resolved` 字段。

`attempts[]` 元素结构：

```yaml
- attempt: 1
  started_at: <ts>
  proposal_ref: healing/fix-proposal.json
  resolved: null    # resolved/exhausted 时回填终值
```

### 2.2 消费端强制

1. **`aws run`（healing-rerun 路径）**：前置 `healing.status == applied`，否则 exit 1：
   `HEAL-STATE-REQUIRED: healing-rerun requires healing.status=applied (current: <s>)`
2. **execution 已 done 后的重复 `aws run`**：非 healing 上下文需 `--rerun-reason <text>`（落 event），否则拒绝。
3. **`aws status` healing 一致性审计**：apply-summary / healing-rerun 事件已出现但 `healing.status` 落后 → 报 `HEAL-STATE-INCONSISTENT`，terminal `stopped`。

### 2.3 SKILL.md 同步

- `aws-workflow` healing 循环（Phase 9–12）各状态写入指令替换为 `aws state heal` 调用；State Ownership 声明 `healing.status` 仅 CLI 可写。
- `aws-fix-proposal` / 两个 codegen-fixer 的"报告 state delta 设 healing.status"改为"报告完成，由 orchestrator 调 `aws state heal`"。

### 2.4 验收（每条先写失败测试）

- [ ] `pending → resolved` 直接调用 → exit 1 `HEAL-TRANSITION-ILLEGAL`
- [ ] `pending → proposal_created` 无 fix-proposal.json → exit 1；有则 attempts[0] 被创建
- [ ] `proposal_created → applied` 无 apply-summary → exit 1
- [ ] `aws run`（healing 上下文）status=pending → exit 1 `HEAL-STATE-REQUIRED`
- [ ] apply-summary 存在 + status=pending → `aws status` 报 `HEAL-STATE-INCONSISTENT` 且 terminal stopped
- [ ] 完整合法链 `proposal_created → applied → resolved` 全绿，attempts 记账正确
- [ ] archive gate 既有检查回归不变

---

## 3. 问题 3 — gate provenance + 人工决策落盘（待实现）

设计依据：state-machine-enforcement §3 + §5。

### 3.1 gate hash 入账

`gate_verdict` 事件（`src/core/events.ts`）新增字段：

```jsonc
"reads_sha256": { "review/plan-review.json": "<sha256>" }
```

`aws gate check` 裁决时对每个 reads 文件计算 sha256 写入。

### 3.2 `aws status` 篡改审计

对每个 gated 且 `done/stopped` 的 phase：当前 reads sha256 vs 最近一次 `gate_verdict.reads_sha256`。

- 不一致 → phase 状态降级 **`tampered`**（`PhaseStatusKind` 新增），输出 `ARTIFACT-TAMPERED: <phase> <file>`，terminal `stopped`。
- 恢复路径唯一：重新 review → 重新 `aws gate check`（产生新 hash）。

### 3.3 verdict 迁移合法性审计

同一 gate 相邻两次 `gate_verdict` 之间：

| 迁移 | 必须存在的中介事件 |
|---|---|
| `needs_fix → pass` | repair phase `phase_transition → done` |
| `needs_human_review → pass` | `human_override` 事件 **且** repair phase done |
| `reject → *` | 不允许（终态） |
| `pass → pass`（hash 变化） | repair phase done |

违反 → `GATE-TRANSITION-ILLEGAL: <gate> <from>→<to>`，terminal `stopped`。

### 3.4 统一命令 `aws decide`

```bash
aws decide --change <id> --at <review-phase> \
  --action fix_and_proceed|skip_branch|accept_and_stop \
  --reason "<text>"
```

- 仅适用 `human_review_required == true` / `risk_level in [high, critical]` 的 STOP；**codegen 硬门不可 override**（CLI 直接拒绝，与 `force_continue` 边界一致）。
- 写入 `phases.<review>.human_override { action, reason, at, review_sha256 }` + append `human_override` 事件。

### 3.5 fixer human_approved 分支（4 个 fixer skill 唯一改动）

默认前置（`human_review_required == false`、severity low/medium）不变。新增例外：

> 存在本 phase `human_override.action == fix_and_proceed` **且** `human_override.review_sha256 == 当前 review JSON hash` → 允许修 blocker/high 项，逐项记入 apply-summary `human_approved_fixes[]`。

铁律不变：fixer 永远不写 review JSON、不改 gate 状态；修完唯一出路是 reviewer 重审 + `aws gate check`。

### 3.6 验收（每条先写失败测试）

- [ ] `gate_verdict` 事件含正确 reads_sha256
- [ ] gate pass 后手改 review JSON → 下一次 `aws status` 该 phase = `tampered`、terminal stopped
- [ ] `needs_human_review → pass` 无 override 事件 → `GATE-TRANSITION-ILLEGAL`
- [ ] override + repair done + 重审 → 迁移合法，全链通过
- [ ] `aws decide` 对 codegen 硬门 phase → exit 1
- [ ] fixer：无 override 时 high severity 拒绝行为回归不变；有 override 且 hash 匹配 → 放行；hash 不匹配 → 拒绝
- [ ] 重演 §设计 1.5 事故流程：手写 pass 路径在 status 被拦；override 路径全链合法

---

## 4. 实施顺序

| 步骤 | 内容 | 对应问题 | 依赖 | 可独立上线 |
|---|---|---|---|---|
| S1 | P1-R1 mode 一致性校验 | 1 收尾 | 无 | ✅ |
| S2 | 事件基建：`heal_transition` / `human_override` 类型 + `gate_verdict.reads_sha256` | 2、3 | 无 | ✅（纯增量） |
| S3 | `aws state heal` 迁移矩阵 + `aws run` 前置检查 | 2 主体 | S2 | ✅ |
| S4 | `aws status` 审计器：篡改 → healing 一致性 → verdict 迁移（三个可分步） | 2、3 检测面 | S2、S3 | 各自独立 |
| S5 | `aws decide` + fixer human-approved 分支 | 3 恢复路径 | S2 | ✅ |
| S6 | SKILL.md 全量同步（aws-workflow healing 段、4 fixer、intake/execute 引用） | 全部 | S3、S5 | 最后 |

全程 TDD：每步先落失败测试（见 §2.4 / §3.6 验收清单），后写实现。

---

## 5. 非目标

- 不做密码学防伪（无信任根）；防纪律漂移，不防恶意对抗。
- 不阻止"整个会话不调任何 CLI"的极端脱轨（archive 前最终审计兜底）。
- 不放松 fixer 安全边界（human_approved 是显式凭据分支，非 severity 松绑）。
- 不改 DAG 结构；审计在 engine/status 层，不进 predicate DSL。
- `force_continue` 暂保留双轨（deprecate 待定）。

## 6. 开放问题

1. `reject` 终态重启路径：新 change vs `override --action reopen`（倾向前者）。
2. `force_continue` 是否 deprecate。
3. events.jsonl 进程外追加保护（git hook / 只读位）：暂不做。
4. deferred OQ 跨 change 记忆：backlog（two-stage 设计 §14.8）。
