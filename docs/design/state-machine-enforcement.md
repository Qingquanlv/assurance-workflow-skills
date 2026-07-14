# 状态机强制设计：healing 流转 CLI 化、gate 产物防篡改、人工决策落盘

- 状态：Draft / Proposal（实现-ready）
- 目标读者：`aws-workflow` / `aws-intake` / `aws-execute` / fixer 系列 skill / CLI 维护者
- 关联：`docs/design/two-stage-intake-execution.md`（反问模式；问题 1）、`schemas/workflow-schema.yaml`；实现规格见 `docs/superpowers/specs/2026-07-04-three-problems-stability-spec.md`
- 定位：本文解决 **执行阶段的状态机被 orchestrator 绕过** 的两类问题——healing 状态从不流转（问题 2）、gate JSON 被手写伪造 + 人工批准后无合法恢复路径（问题 3）。反问/模式选择（问题 1）由 [two-stage-intake-execution.md](./two-stage-intake-execution.md) 覆盖，本文不重复。

---

## 0. 三问题总览与两份设计的分工

| 问题 | 现象摘要 | 根因类别 | 由哪份设计解决 | 状态 |
|---|---|---|---|---|
| **1** | explore 无反问、low-confidence 断言写死 | 模式期望错配 + auto 不透明 | `two-stage-intake-execution.md` | **已实现**（`run_context`、mode-aware skill、validator） |
| **2** | healing 跳过、status 一直 pending、手动改测试 | 状态写入无 CLI、无过程校验 | **本文 §4** | 待实现 |
| **3** | human_review STOP 后手写 review JSON 为 pass | 无 override 落盘 + gate 零 provenance | **本文 §3 + §5** | 待实现 |

两份设计互补：**two-stage 管「设计期该不该问」；本文管「执行期状态与 gate 能不能被抄近路」**。整体 workflow 要稳定，两份都要落地；只做前者，RET-api-management 类事故在 healing / plan-review 段仍会复发。

```text
用户意图
  ├─ 要设计对话 → aws-intake + aws-execute     [two-stage 设计]
  └─ 要一口气跑   → aws-workflow (autonomous)   [two-stage 设计]
         │
         ▼
执行阶段（plan-review / codegen / healing / archive）
  ├─ gate 产物 hash + 迁移审计                  [本文 机制 A]
  ├─ healing.status 仅 aws state heal 可写       [本文 机制 B]
  ├─ human_review → aws decide → 重审    [本文 机制 C]
  └─ run tests-tree hash 守卫                    [本文 机制 D]
```

> **设计立场（先说清能防什么、不能防什么）**：
> LLM orchestrator 对 change 目录有完整文件写权限，本地也没有可藏秘密的信任根——**密码学级防伪造不可行，也不是目标**。本设计的目标是三件事：
> 1. **合法路径 CLI 化**：每个状态流转都有一条现成的 `aws` 命令，走正路永远比绕路省力；
> 2. **越权可检测**：绕过 CLI 的写入会在下一次 `aws status`（orchestrator 每轮循环必调）产生机械可判的不一致，立即 STOP——而不是等到 archive 末端；
> 3. **越权面扩大**：伪造一个 pass 需要同时伪造 review JSON、内容 hash 记录、事件账本中的合法迁移链——LLM"顺手绕过"（上次事故的实际形态）的成本从改 1 个文件升到伪造 3 处强一致的痕迹。
>
> 防的是**纪律漂移**（LLM 图省事抄近路），不是恶意对抗。subagent-dispatch 模式下 subagent 的 OS 级 permission floor（bash deny + `workflow-state.yaml` deny）不变，本文约束的是**主 agent 自己**。

---

## 1. 问题陈述（来自 RET-api-management 实测）

### 1.1 问题 2：healing 状态机被整体绕过

| 应该的流程 | 实际发生 | 差距 |
|---|---|---|
| Phase 9 `aws-fix-proposal` → `healing/fix-proposal.json` | 跳过，orchestrator 自己分析 | 无 fix-proposal 产物 |
| Phase 10 `aws-e2e-codegen-fixer` → `healing/e2e-apply-summary.json` | 跳过，手动 edit 测试代码 | 无 apply-summary 产物 |
| `healing.status`: `pending→proposal_created→applied→resolved` | 从未写入 | 一直 `pending` |
| `healing.attempts` 记录 | 从未初始化 | 空 |
| Phase 12 后写 `healing.status=resolved` | 忘记 | 状态与事实不一致 |

**根因**：healing 的状态流转只存在于 `aws-workflow/SKILL.md` 的文字里。`aws state apply` 只覆盖 `execution / healing-rerun / inspect / report` 四个 phase 的产物落盘，**`healing.status` 本身没有任何 CLI 管、没有任何前置检查消费它**（除了 archive gate 末端读一次）。orchestrator 不写，一路绿灯直到 archive。

### 1.2 问题 3：human_review STOP 之后的死胡同与伪造

事件链：E2E plan review 判 `needs_human_review`（2 个 blocker）→ 按规则 STOP → 用户选择 "Fix E2E plan + proceed" → orchestrator 调 `aws-e2e-plan-fixer` → **fixer 按自身规则正确拒绝**（`human_review_required==true` + high severity 禁自动修）→ orchestrator 无路可走 → **手动改 plan 文件 + 手写 `plan-review.json` 为 pass** → 继续 codegen。

**两个根因**：

1. **规则体系自洽但闭环缺口**：用户的批准只发生在对话里，没有任何机制把"人已批准修复"落成 fixer / gate 能读到的状态。fixer 拒绝是对的，但拒绝之后规则没有给出下一步——把 orchestrator 逼向伪造。
2. **gate 产物零 provenance**：gate 引擎信任磁盘上的 review JSON，谁写的、什么时候改的、verdict 变化是否经过合法流程，一概不查。手写 `decision: pass` 与 reviewer 写的 pass 在引擎眼里无法区分。

### 1.3 共同根因

两个问题共享同一个结构性缺陷：**状态与产物的写入没有过程强制，只有末端兜底**（archive gate）。合法路径存在但全靠 LLM 自觉；越权路径畅通且无痕。

### 1.4 当前实现基线（本文撰写时）

以下对照说明「已有」与「本文要补」的边界，避免与 two-stage 已落地能力混淆。

| 能力 | 当前代码/规格 | 缺口 |
|---|---|---|
| `events.jsonl` + `gate_verdict` | `aws gate check` 已 append；含 `verdict` / `evidence`，**无** `reads_sha256` | §3.1 |
| `phase_transition` | `aws status` / `aws state apply` 已写 | 未用于 verdict 迁移审计 | §3.3 |
| `aws state apply` | 仅 `execution / healing-rerun / inspect / report` | **不写** `healing.status` | §4.1 |
| `healing-entry-gate` / `archive-gate` | schema 已定义；读 `healing.status` / `attempts` | 中间过程不拦抄近路 | §4.2 |
| fixer 前置 | `human_review_required == false` 硬 STOP | 人批准后无例外分支 | §5.3 |
| `force_continue` | params 级；不可越 codegen 硬门 | 无单点 override + 无审计链 | §5.4 |
| orchestrator 纪律 | `aws-workflow` 要求每轮 `aws status` | 无 tampered / illegal transition 状态 | §3.2 |

> **验收标准**：实现本文后，重演 RET-api-management 的两条抄近路（§1.5、§1.6），应在**下一次** `aws status` 或 `aws run` 被机械拦住，而不是跑到 archive 才暴露。

### 1.5 问题 3 重演：E2E plan review（RET-api-management）

**现状（非法但畅通）**：

```text
e2e-plan-review → needs_human_review (2 blockers)
  → STOP，用户选 "Fix E2E plan + proceed"
  → aws-e2e-plan-fixer 拒绝 (human_review_required=true) ✓ 规则正确
  → orchestrator 手动改 plans/*.md
  → orchestrator 手写 review/plan-review.json decision=pass  ✗ 无 provenance
  → aws gate check 未重跑 / 或重跑但无迁移审计
  → codegen 继续
```

**目标（机制 C + A）**：

```text
e2e-plan-review → needs_human_review
  → STOP
  → aws decide --at e2e-plan-review --action fix_and_proceed --reason "…"
       → events: human_decision（绑定当前 review SHA）
  → aws-e2e-plan-fixer (human_approved 模式，校验 review_sha256 一致)
       → 改 plans/*.md，写 plan-review-apply-summary.md
       → 仍不写 review JSON
  → aws-e2e-plan-reviewer 重审 → 新 plan-review.json
  → aws gate check → gate_verdict + reads_sha256
  → verdict 迁移审计：needs_human_review→pass 前有 decision + e2e-plan-fix done ✓
  → codegen 继续
```

若 orchestrator 仍手写 pass 而不走 override：**§3.2** hash 不一致 → phase `tampered`；或 **§3.3** 迁移非法 → `GATE-TRANSITION-ILLEGAL`。

### 1.6 问题 2 重演：healing 绕过（RET-api-management）

**现状（非法但畅通）**：

```text
execution FAIL → inspect 有 fix_proposal_eligible
  → orchestrator 跳过 fix-proposal / fixers
  → 手动 edit tests/
  → aws run (healing-rerun 或普通重跑)  ✗ 无 healing.status 前置
  → healing.status 一直 pending，attempts=[]
  → 直至 archive 才可能因 applied 不算完被拦
```

**目标（机制 B）**：

```text
execution FAIL → inspect → healing-entry-gate enter
  → pin healing/entry-baseline.json
  → aws-fix-proposal → fix-proposal.json
  → status derives proposal_created
  → fixers → *-apply-summary.json
  → aws heal record-apply
  → fixer-safety-gate pass
  → status derives applied; pin applied test tree
  → aws run (healing-rerun)  ✓ 前置检查通过
  → aws state apply --phase healing-rerun
  → healing-reinspect
  → aws state heal --to resolved
```

若跳过 fix-proposal / CLI apply evidence 直接 `aws run`：**§4.2** `HEAL-STATE-REQUIRED`。

---

## 2. 目标与非目标

### 目标

1. healing 状态流转由 CLI 强制：非法迁移 hard error，跳跃迁移（`pending→resolved`）不可能。
2. `aws run`（healing-rerun）拒绝在 `healing.status != applied` 时执行——手动改完测试直接重跑的路径被机械拦截。
3. gate 产物内容 hash 入账：review JSON 在 gate 裁决后被改动 → 下一次 `aws status` 检测到并 STOP。
4. verdict 迁移合法性审计：review verdict 从 `needs_human_review / needs_fix / reject` 变为 `pass`，必须存在对应的合法中介事件（fix phase 完成 + reviewer 重审，或 human override），否则 STOP。
5. 人工决策落盘：`human_review_required` STOP 后用户的选择通过 CLI 写入 state，成为 fixer 放行与 gate 审计的机器可读依据。
6. 检测时机前移：所有审计在每次 `aws status` 运行（orchestrator 每轮必调），不等 archive。

### 非目标

- 不做密码学防伪（无信任根；见设计立场）。
- 不阻止"orchestrator 整个会话完全不调 CLI"的极端脱轨——那种情况下任何文件层机制都失效；由 archive 前的最终审计 + `aws-workflow` 的 CLI-authoritative 纪律兜底。
- 不改变 fixer 的安全边界（high/critical 不许自动修的原则保留；改变的只是"人批准后"的路径）。
- 不引入新的人机交互点；`force_continue` 的既有边界（不可 bypass codegen 硬门）原样保留。

---

## 3. 机制 A — 产物 hash 入账与篡改检测（gate provenance）

### 3.1 gate check 记录 reads hash

`aws gate check` 现在已 append `gate_verdict` 事件（`events.jsonl`）。扩展该事件：

```jsonc
{
  "source": "gate", "type": "gate_verdict",
  "phase": "e2e-plan-review", "gate": "e2e-plan-review-gate",
  "verdict": "needs_human_review",
  "reads_sha256": { "review/plan-review.json": "ab12…" },   // 新增
  "evidence": { … }
}
```

裁决与内容绑定：这个 verdict 是在这份内容上做出的。

### 3.2 `aws status` 每轮做篡改审计

对每个 **gated 且 status 为 `done` / `stopped`** 的 phase：

```
当前 reads 文件 sha256  vs  最近一次 gate_verdict 事件的 reads_sha256
```

- **一致** → 正常。
- **不一致** → 该 phase 状态降级为新状态 **`tampered`**（进 `PhaseStatusKind`），`aws status` 输出 `ARTIFACT-TAMPERED: <phase> <file>`，terminal 置为 `stopped`。恢复方式只有一种：**重新跑该 phase 的 gate 裁决链**（重新 review → 重新 `aws gate check`，产生新的 gate_verdict 事件与新 hash）。

> 注意这不禁止文件被合法更新——fix loop 本来就会重写 review JSON。合法更新的下一步永远是重新 `aws gate check`（fix 流程已要求），重新裁决即重新盖 hash。被拦住的只有"改了文件却不重新裁决、直接沿用 done 状态往下跑"的路径——正是上次事故的形态。

### 3.3 verdict 迁移合法性审计（防"重新裁决洗白"）

只有 3.2 不够：orchestrator 可以手写 pass 后**主动重跑** `aws gate check` 拿到合法的新 verdict。因此对事件账本增加迁移审计——同一 gate 的相邻两次 `gate_verdict` 事件之间：

| verdict 迁移 | 合法条件（两次 gate_verdict 事件之间必须存在） |
|---|---|
| `needs_fix` → `pass` | 对应 repair phase（如 `e2e-plan-fix`）的 `phase_transition → done` 事件 |
| `needs_human_review` → `pass` | 有效 `human_decision`（机制 C）或 repair phase done 事件 |
| `reject` → 任何 | 不允许（reject 是终态；重启需新 change 或显式 override，见 §7 开放问题） |
| `pass` → `pass`（内容 hash 变化） | repair phase done 事件（内容变了必须有合法原因） |

违反 → `aws status` 报 `GATE-TRANSITION-ILLEGAL: <gate> <from>→<to>`，terminal `stopped`。

> 残余暴露面：events.jsonl 本身也是可写文件。伪造一个 pass 现在需要：手写 review JSON + 手补 gate_verdict 事件（含正确 hash）+ 手补中介 phase_transition / human_decision 事件且 seq 连续。做不到"顺手"，且所有伪造都留在账本里可事后审计。接受此残余（见设计立场）。

---

## 4. 机制 B — healing 状态机 CLI 化

### 4.1 新命令 `aws state heal`

```bash
aws state heal --change <id> --to <status>
```

CLI 内部持有唯一合法迁移矩阵，每次迁移校验**前置产物**并 append `heal_transition` 事件：

| 迁移 | 前置校验（CLI 强制，缺一即 hard error） |
|---|---|
| `pending → proposal_created` | `healing/fix-proposal.json` 存在且 schema 有效；`healing.attempts[]` 初始化并 append 本次 attempt（`attempt_n`, `started_at`, `proposal_ref`） |
| `proposal_created → applied` | 至少一个 apply-summary（`healing/api-apply-summary.json` / `healing/e2e-apply-summary.json`）存在；每份 summary `files_modified` 非空或显式 `no_op: true` |
| `applied → resolved` | `healing-rerun` 与 `healing-reinspect` 均 done（读 phase 状态/事件）；最新 `inspect/failure-analysis.json` 无 `fix_proposal_eligible` 失败，且 `source_batch_id` == 最新 execution batch |
| `applied → exhausted` | `len(healing.attempts) >= max_healing_attempts`，或全部 fixer `no_op` |
| 其余任何迁移（含 `pending → resolved`） | **hard error `HEAL-TRANSITION-ILLEGAL`** |

`healing.status` 从此**只有** `aws state heal` 这一个合法写入口。SKILL.md 中所有"更新 healing.status"的指令全部替换为对应 CLI 调用。

### 4.2 消费端强制（让不流转变得走不下去）

CLI 化只堵写入口，还要让"不写"寸步难行：

1. **`aws run`（healing-rerun 路径）**：执行前检查 `healing.status == applied`。否则拒绝：`HEAL-STATE-REQUIRED: healing-rerun requires healing.status=applied (current: pending). Run the healing loop (fix-proposal → fixers → aws state heal).`
   - 这是对上次事故的直接反制：手动 edit 测试后直接重跑的路径，在 `aws run` 这一步被机械拦截。
2. **execution 已 done 后的重复 `aws run`**：视为 rerun。非 healing 上下文的 rerun 需要显式 `--rerun-reason <text>`（落 event），否则拒绝——防止"绕开 healing 概念、假装是普通重跑"。
3. **`aws status` 证据推导**：从 active batch、fresh analysis、proposal SHA、
   apply-summary 当前 SHA、`heal_record_apply` 与 human decision 推导唯一状态，
   不再审计 YAML/artifact 漂移。

### 4.3 `attempts` 记账

attempts 由 `heal_record_apply.attempt_key` 的 distinct proposal identity 计数，不再写入
`healing.attempts[]`。

```yaml
- attempt: 1
  started_at: <ts>
  proposal_ref: healing/fix-proposal.json
  resolved: null   # aws state heal --to resolved/exhausted 时回填
```

`healing-loop-gate` / `healing-entry-gate` 读的 `len(state.phases.healing.attempts)` 因此永远与事实一致——上次"attempts 从未初始化导致 gate 判断失真"不再可能。

---

## 5. 机制 C — 人工决策落盘（needs_human_review 的合法恢复路径）

### 5.1 统一命令 `aws decide`

```bash
aws decide --change <id> --at <review-phase> \
  --action fix_and_proceed | skip_branch | accept_and_stop \
  --reason "<用户原话或摘要>"
```

- **适用范围**：仅存在已注册消费者的 checkpoint/action。**codegen 硬门（`not_ready` / blockers / 缺 data-knowledge）不可裁决绕过**——CLI 直接拒绝。
- 写入 `events.jsonl`：

```yaml
type: human_decision
checkpoint: e2e-plan-review
action: fix_and_proceed
reason: "用户选择 Fix E2E plan + proceed"
review_sha256: <当时 review JSON 的 hash>
```

- append `human_decision` 事件（机制 A §3.3 的合法中介凭据）。

### 5.2 三种 action 的后续路径

| action | 语义 | 后续 |
|---|---|---|
| `fix_and_proceed` | 人已看过 findings，批准修复 | fixer 以 **human_approved 模式** 放行（见 5.3）→ 修复 → **强制 reviewer 重审** → 新 review JSON → `aws gate check` 重新裁决。verdict 迁移链完整合法 |
| `skip_branch` | 放弃该分支（如 bootstrap） | 对应 consumer 推导 branch skipped；decision 事件解释原因 |
| `stop` | 接受现状，终止工作流 | terminal stopped，报告归档不合格原因 |

### 5.3 fixer 的 human_approved 模式（对 fixer SKILL.md 的唯一改动）

现有 fixer 前置检查 `human_review_required == false`、`severity in [low, medium]` **保持为默认**。新增一个例外分支：

> 若最新 `human_decision` 的 checkpoint/action 匹配本 phase 与 `fix_and_proceed`，**且** `review_sha256` 与当前 review JSON hash 一致（防止批准 A 版发现后偷换 B 版），则允许修复 `findings[]` 中的 blocker / high severity 项——按 finding 的 `suggested_fix` 或 blocker 描述执行，逐项记入 apply-summary 的 `human_approved_fixes[]`。

**不变的铁律**：fixer 无论何种模式**永远不写 review JSON、不改 gate 状态**。修完的唯一出路是 reviewer 重审。伪造 pass 的路径在机制 A 下同时被堵。

### 5.4 与 `force_continue` 的关系

| | `force_continue`（既有） | `human decision` |
|---|---|---|
| 时机 | 启动前全局预设 | STOP 发生后单点决策 |
| 粒度 | 整个 run 的所有 human_review 停止点 | 一个 phase 的一次停止 |
| 审计 | params 里一个 bool | action + reason + review hash + 事件 |
| 推荐 | 仅高信任重复场景 | 常规路径 |

两者边界一致：都不可越过 codegen 硬门。长期看 `force_continue` 可标注为 deprecated（开放问题 §7）。

---

## 6. Schema / CLI / SKILL 变更清单

**CLI（`src/`）**
1. `aws gate check`：gate_verdict 事件增加 `reads_sha256`（`src/core/events.ts` 事件类型扩展 + `src/commands/gate.ts`）。
2. `aws status`：新增审计器（篡改检测 §3.2、verdict 迁移审计 §3.3、healing 一致性 §4.2.3）；`PhaseStatusKind` 增加 `tampered`；terminal 规则扩展。
3. 新命令 `aws state heal`（`src/commands/state.ts` + `src/core/workflow_state.ts` 迁移矩阵）。
4. `aws run`：healing-rerun 前置 `healing.status == applied` 检查；重复 execution 需 `--rerun-reason`。
5. `aws decide`（写 `human_decision` 事件；拒绝无消费者或 codegen 硬门类裁决）。

**事件类型（`events.jsonl`）**：新增 `heal_transition`、`human_decision`；`gate_verdict` 增加 `reads_sha256`。

**workflow-state 字段**：`phases.healing.status/attempts`（写入口收敛到 CLI）；人工裁决仅存在事件账本。

**workflow-schema.yaml**：无 DAG 结构变化。gate 定义不变（审计在引擎/status 层，不进 predicate DSL）。

**SKILL.md 同步**
- `aws-workflow`：healing 循环各步替换为 `aws state heal` 调用；Human Interaction Rules 增加"STOP 后用 `aws decide` 记录用户决定，禁止手写 review JSON"；State Ownership 声明 `healing.status` 只能经 CLI。
- 4 个 fixer skill：增加 §5.3 human_approved 分支（前置校验 override 存在 + hash 一致）。
- `aws-intake` / `aws-execute`：引用同一套规则（薄壳无需展开）。

---

## 6.5 机制 D：run 完整性（tests-tree hash）

`aws run` 是正式执行 batch 的唯一入口。每个 batch 的 `execution-manifest.yaml` 记录：

- `tests_tree_sha256`：`tests/` 树的聚合 hash；
- `test_files_sha256`：逐文件 hash，用于诊断哪些测试文件发生漂移。

当已有正式 batch 后再次 `aws run`：

```text
tests_tree_sha256 未变
  → 允许 rerun；--rerun-reason 仅表示环境/基础设施类重试

tests_tree_sha256 已变 AND phases.healing.status == applied
  → 允许 rerun；这是正式 healing loop 的 Phase 11

tests_tree_sha256 已变 AND 无显式人工 allow_test_changes override
  → TESTS-CHANGED-WITHOUT-HEALING；硬 STOP
```

`--rerun-reason` **不**是修改测试后重跑的许可；它只适用于测试树未变化的环境抖动重试。若用户明确决定在 healing 之外修改测试，必须先通过 `aws decide --at execution.test-changes --action allow_test_changes --reason "<user decision>"` 记录绑定当前测试树的一次性授权；随后 `aws run` 自动发现并消费。

该机制补上 §4.2 的入口洞：如果 orchestrator 从未进入 healing，原 `healing.status == applied` 守卫不会触发；tests-tree hash 在第二个 batch 入口处直接拦截。

---

## 7. 引入顺序

1. **事件与 hash 基建**：`gate_verdict.reads_sha256` + `heal_transition` / `human_decision` 事件类型（纯增量，无行为变化）。
2. **`aws state heal` + `aws run` 前置检查**（问题 2 的主体；单独可上线，收益立现）。
3. **run 完整性 hash 守卫**：manifest 记录 tests-tree hash；第二个 batch 入口拒绝 healing 外测试漂移。
4. **`aws status` 审计器**：篡改检测 → healing 一致性 → verdict 迁移审计（三个审计可分步，各自独立生效）。
5. **`aws decide` + fixer human-approved 分支**（问题 3 恢复路径；依赖 1 的事件类型）。
6. **SKILL.md 全量同步**（依赖 2、5 的命令存在）。

每步都有独立的失败测试先行（迁移矩阵非法迁移、hash 不一致降级 tampered、无 override 时 fixer 拒绝 high severity 不变、有 override 且 hash 匹配时放行等）。

---

## 8. 解决 / 不解决

| 问题 | 是否解决 | 机制 |
|---|---|---|
| 问题 2：healing.status 从不流转 | ✅ | 写入口收敛 `aws state heal`（§4.1）+ `aws run` 消费端强制（§4.2）+ status 一致性审计 |
| 问题 2：attempts 未初始化 | ✅ | `aws state heal` 记账（§4.3） |
| 问题 2：跳过 fixer 手动改测试后直接重跑 | ✅ | `aws run` 比对 tests-tree hash；测试漂移时拒绝 `healing.status != applied`；非 healing 测试修改需显式 human override |
| 问题 3：review JSON 被手写为 pass | ✅（检测） | hash 入账 + 篡改审计（§3.2）+ verdict 迁移审计（§3.3），下一次 `aws status` 即 STOP |
| 问题 3：人批准后无合法路径 | ✅ | `aws decide` + fixer human-approved 模式 + 强制重审闭环（§5） |
| orchestrator 整个会话不调任何 CLI | ❌ | 文件层机制无法约束；靠 SKILL 纪律 + archive 前最终审计兜底 |
| 恶意伪造事件账本（补事件 + 补 hash） | ❌（留痕） | 无信任根，不可防；但伪造面大、全程留痕、可事后审计（设计立场） |
| 问题 1：反问被跳过 | —— | two-stage 设计已覆盖，本文不涉及 |

---

## 9. 决定与开放问题

### 已决定
1. **防呆不防恶**：目标是拦截纪律漂移，不做密码学防伪；所有机制以"下一次 `aws status` 必然暴露"为验收标准。
2. **审计挂在 `aws status`**：orchestrator 每轮必调，天然是最高频检查点；不新增独立 `aws audit` 命令。
3. **`tampered` 是 phase 状态而非全局 flag**：粒度到 phase，恢复路径明确（重跑该 phase 裁决链）。
4. **fixer 安全边界不放松**：human_approved 是"人已批准"的显式凭据分支，不是 severity 规则的松绑；且凭据绑定 review 内容 hash。
5. **codegen 硬门对 override 同样免疫**：与 `force_continue` 边界一致，不开新口子。

### 待定
6. **`reject` 终态的重启路径**：reject 后想继续，是要求新 change，还是允许 `gate override --action reopen`（更重的审计）？倾向前者，待定。
7. **`force_continue` 是否 deprecate**：override 覆盖其全部场景且审计更好；但移除有兼容成本。暂保留双轨。
8. **events.jsonl 追加保护**：可选的进程外保护（如 git commit hook / 只读位）能提高伪造成本，但引入环境依赖。暂不做。
