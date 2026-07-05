# 反问模式设计：`full`（自主）与 `two-stage`（交互式意图捕获 + 自主执行）

- 状态：Draft / Proposal
- 目标读者：`aws-workflow` / `aws-explore` / `aws-case-design` / `aws-case-reviewer` 维护者
- 关联：`docs/design/workflow-schema.yaml`（当前 phase DAG 与 gate 模型）；实现规格见 `docs/superpowers/specs/2026-07-04-three-problems-stability-spec.md`
- 定位：本文把 **「反问（计划内人机对话）」定义为一个模式级开关**，而不是强制塞进所有执行的关卡。它只解决「反问该在什么时候发生、由谁触发、如何不被自主流碾压」（问题 1）。healing 状态机被绕过、gate JSON 被伪造（问题 2、3）属于 **执行阶段的状态机强制**，由另一份「state-machine enforcement」设计单独处理，本文不覆盖。

> **设计立场（相对早期草案的两次修正）**：
> 1. 早期草案强制把 `intake-gate` 硬 checkpoint 塞进 `full`，属于过度设计。本版改为：**反问是模式的差异，不是所有模式都必须经过的关卡。** `full` 保持"一口气跑完、不反问、只被硬 gate 拦"；想要设计对话就显式选 `two-stage`。
> 2. **不引入 `intake_mode` 参数、不新增 `intake-approved.yaml` 交接产物。** 模式的选择 = **你调用哪个 skill**。实现方式：`aws-workflow` 微调后即 `full` 模式；新增两个薄 orchestration skill 承载 `two-stage` 的两个阶段。阶段二用 **preflight 读现有产物**（`review/case-review.json` 为 pass + `advisory.json` 无 unanswered open_question）完成交接，不再需要新文件与新 gate。

---

## 1. 问题陈述与重新定性

### 1.1 现象

在 `RET-api-management` 一次 `full` 执行中：

- `explore/advisory.json` 的 `open_questions_for_case_design: []` 为空 → 无反问 → 直接接续 case-design。
- 4 条 `priority_hints` 全为 `confidence: low`，却把断言方向（"断言理想行为：…"）**写死进 hint 文案**。
- `explore.open_questions_answered: 0`。

### 1.2 重新定性：这是「模式期望错配」，不是纯 bug

关键认知修正：

- 如果本次运行的语义是 **`full`（自主模式）**，那么"不反问、直接跑"**是符合模式定义的正确行为** —— 问题不在于跳过反问，而在于 explore **偷偷猜**了断言方向却不标注（把 auto 决策伪装成结论）。
- 用户真正想要的是 **设计对话**，那应该走 **`two-stage` 模式**，其阶段一显式反问。

所以问题 1 的根因不是"反问被碾压"，而是 **缺少一个显式的、承载反问的模式**，以及 **`full` 模式下 auto 决策不透明**。

### 1.3 两种人机交互（保持区分）

| 类型 | 发生位置 | 性质 | 两种模式下的处理 |
|---|---|---|---|
| **计划内设计对话（反问）** | 阶段一 | 正常路径，批量集中 | `two-stage` 才有；`full` 用透明 auto 策略替代 |
| **异常 gate** | 执行阶段 | 稀有，出事才停 | 两种模式都保留（`human_review_required` → STOP + ask） |

> 任何模式都不会消除异常 gate。`full` 不是"无脑冲"，它照样被 case-review reject / plan-review blocker / `human_review_required` / codegen 硬 gate / healing exhausted / risk high|critical 拦停。

---

## 2. 设计目标与非目标

### 目标
1. 把「反问」变成一个**显式的模式选择**，而不是隐式依赖 orchestrator 自觉。
2. `full`：不反问，一口气执行完，保留全部硬 gate；auto 决策**透明标注**（不得伪装成用户结论）。
3. `two-stage`：阶段一集中反问（explore + case-design + case-reviewer + case-fixer），阶段二后续流程一口气自主跑完，保留硬 gate。
4. 反问的问题由证据派生（explore 先发现坑，再问坑），不做纯前置。

### 非目标
- 不强制所有执行经过 intake checkpoint（早期草案的做法，已废弃）。
- 不解决 healing 状态机被绕过 / gate JSON 被伪造（另文）。
- 不改各 skill 的核心产物 schema，只新增少量状态字段；two-stage 阶段交接复用既有产物，不新增专用交接文件。
- 不消除执行阶段的异常人机 gate。

---

## 3. 两种模式定义

### 3.1 Mode `full`（自主 / 快车道）

```
explore(发现坑，auto 定断言方向，透明标注 answered_via=auto_default)
  → case-design(不反问，直接用 explore 的 test_strategy 提案 + 默认策略生成 cases)
  → case-review → [case-fix if needed]
  → fact-baseline → plan → plan-review → codegen → execution
  → inspect → (healing loop) → report → archive-eligibility
一口气跑完；仅被硬 gate 拦停。
```

- **explore**：仍发现 pitfalls、产出 advisory；对需要断言取舍的坑，按**默认策略**自动定向（见 §4.2），并标注 `answered_via: auto_default`、`assertion_intent` 显式写出，**禁止**把 auto 决策留白或伪装成"已确认"。
- **case-design**：不向用户提澄清问题，直接采用 explore 的 `test_strategy` 提案与默认取值。
- **保留的硬 gate**（`full` 同样触发 STOP）：
  - `case-review`：`reject` / `human_review_required` / `risk_level in [high,critical]`
  - `api/e2e-plan-review`：`blockers` 非空 / `codegen_readiness == not_ready` / `human_review_required`
  - codegen 硬门（缺 `data-knowledge.yaml` 等）
  - healing `exhausted`

### 3.2 Mode `two-stage`（交互式意图捕获 + 自主执行）

```
━━━ 阶段一 INTAKE（skill: aws-intake；交互式；inline；反问在此）━━━
  explore(发现坑) → 逐坑反问 → case-design(反问澄清) → case-review → [case-fix]
  收敛条件：advisory 无 unanswered open_question 且 case-review == pass
━━━ 交接（handoff = 阶段二 preflight 读现有产物，无新文件）━━━
━━━ 阶段二 EXECUTE（skill: aws-execute；自主；一口气；保留硬 gate）━━━
  fact-baseline → plan → plan-review → codegen → execution
  → inspect → (healing loop) → report → archive-eligibility
```

- 阶段一是**唯一承载反问**的地方：explore 逐坑断言取舍 + case-design 宏观澄清。
- 阶段一与阶段二是**两次显式调用**：先跑 `aws-intake`，交互完成后再由用户启动 `aws-execute`。见 §7 Resume。
- 阶段二与 `full` 的执行部分**完全一致**，唯一区别是它消费的是"经过反问确认的意图"。

### 3.3 两模式对比

| 维度 | `full` | `two-stage` |
|---|---|---|
| explore 反问 | ✗（auto 默认策略） | ✅ 逐坑一问 |
| case-design 澄清 | ✗（用 test_strategy 提案） | ✅ |
| 执行方式 | 一口气 | 阶段二一口气 |
| 硬 gate 停止 | ✅ 保留 | ✅ 保留 |
| 承载 skill | `aws-workflow`（微调） | `aws-intake` + `aws-execute`（两个新 skill） |
| 阶段交接 | 无（连续执行） | 阶段二 preflight 读现有产物（无新文件） |
| 适用场景 | 信任默认、追求速度 | 需要人工把关设计意图 |

---

## 4. 反问在两种模式下的行为

### 4.1 open_questions 的来源（两模式共用）

explore 只产出**中性 draft hint**（描述坑，不预设断言方向），并对满足条件的坑生成 `open_question`：

- 规则（写入 `aws-explore/SKILL.md`）：凡 `confidence <= medium` 且涉及断言取舍的坑，**必须**生成一条 linked、`status=unanswered` 的 `open_question`（`pitfall_ref` 指向它）。

### 4.2 两模式对 open_questions 的处理差异

| | `full` | `two-stage` 阶段一 |
|---|---|---|
| 处理方式 | **auto 默认策略**：按下表自动定 `assertion_intent`，标 `answered_via: auto_default` | **逐条一次一问**：用户答 → `answered`；跳过 → `deferred` |
| 断言默认策略 | ideal-behavior 类坑 → `assert_ideal`；无法判定 → `undecided`（case-design 用中性措辞） | 由用户决定 |
| 透明度要求 | 必须在 advisory/state 里显式标注为 auto，**禁止**伪装成用户确认 | `answered_via: aws-intake` |
| 是否阻塞 | 不阻塞（auto 一律有终态） | `unanswered > 0` → 阶段二 preflight 拒绝启动 |

> `full` 的核心纪律：**可以自动决策，但必须透明。** 这直接修掉本次 explore"偷偷把 low-confidence 断言写死"的问题 —— auto 决策要留痕、可审计、可在事后被人推翻。

### 4.3 deferred 语义（`two-stage` 专用）

- 用户显式跳过 → `status=deferred` + `deferred_reason`，不阻塞阶段二 preflight。
- deferred 的坑：case-design 用中性措辞，不生成对应断言。
- 连续跳过 ≥3 条 → 剩余一次性转 deferred（沿用 explore Step 5 现有行为）。

---

## 5. 阶段一/阶段二边界（仅 `two-stage`）

阶段一 = **Phase 0 test-infra-bootstrap** + `explore + case-design + case-reviewer + case-fixer`。
阶段二 = `fact-baseline` 起的全部后续 phase。

边界**只在 `two-stage` 存在**；`full` 无此边界（连续执行）。

### 5.1 Phase 0 / fact-baseline 归属

| Phase / skill | 归属 | 理由 |
|---|---|---|
| `aws-test-infra-bootstrap` | **阶段一（intake）主跑** | 唯一可能反问用户的 infra 步骤（URL/凭据拿不准须问）；两阶段设计把所有人机交互前置到 intake |
| `aws-test-infra-bootstrap` | 阶段二（execute）**preflight 幂等校验** | 三文件存在且合规则跳过；缺失/不合规 → hard STOP，指引回 intake，execute 不反问 |
| `aws-fact-baseline` | **阶段二（execute）** | `requires: case-review`；产物只被 plan/codegen 消费；自主采集、不反问（unavailable 时 warning 继续） |

`test-infra-bootstrap` 不在 `workflow-schema.yaml` DAG 内（与 `full` 相同，为 orchestrator inline Phase 0）；`fact-baseline` 已在 schema 中 `owned_by: [full, execute]`。

---

## 6. 模式的实现：三个 orchestration skill

模式的选择 = **调用哪个 skill**。不新增参数，不新增交接产物。

| Skill | 角色 | 拥有的 phase | 反问 | 改动 |
|---|---|---|---|---|
| `aws-workflow` | `full` 模式（现有，微调） | 全流程 explore→archive-eligibility | ✗（透明 auto） | 微调 |
| `aws-intake` | `two-stage` 阶段一（新） | Phase 0 bootstrap + explore + case-design + case-reviewer + case-fixer | ✅ 逐坑一问 + bootstrap 配置确认 | 新增（薄） |
| `aws-execute` | `two-stage` 阶段二（新） | fact-baseline→archive-eligibility（preflight 校验 bootstrap） | ✗ | 新增（薄） |

### 6.1 复用原则：中间路径（内联 runbook + 引用共享机制）

> **修订（防执行遗漏）**：最初版本让 `aws-intake` / `aws-execute` 作纯薄壳，把一切都"引用 `aws-workflow` 对应章节"。实测发现纯引用会导致**执行遗漏**——薄壳 87 行让 agent 去 3425 行里自己抽取相关段落，容易漏读交叉引用（漏 gate check、漏 healing 流转、漏某步）。整体 fork（把 workflow 内容复制三份）又会引入更严重的**漂移**（三份 gate / state-machine 规则发散，正是 state-machine-enforcement 要根治的 bug 温床）。因此采用**中间路径**。

把 `aws-workflow` 的内容分三桶，按"遗漏 vs 漂移"哪个代价高分别处理：

| 桶 | 内容 | 处理 | 理由 |
|---|---|---|---|
| **有序 runbook** | phase 顺序、每步 gate check 点、healing 的 `aws state heal` CLI 序列、human review 恢复路径、scope 内 stop conditions | **内联进 `aws-intake` / `aws-execute`**（写成无缺口 checklist） | 遗漏就发生在这层；内联直接消除 |
| **共享机制（C 桶）** | Scheme E dispatch + state-hash、Phase Completion Rule、Skill Load Gate、Phase→Skill Map、`workflow-state.yaml` schema、Subagent 权限模型、Context Budget/Handoff | **引用 `aws-workflow`** | 大、跨模式完全一致、漂移代价最高 → 保持单源 |
| **逐 phase 深度契约** | 每个 phase 的详细输入/输出/gate | **留在各 phase skill**（`aws-fact-baseline`、`aws-api-plan`…） | 本就按需加载；跑到该 phase 时才进上下文 |

两个新 skill 因此做四件事：

1. 声明自己拥有的 **phase 子集**（`active_scope`）；
2. 启动时把 **run_context**（含 `interaction_mode`）盖进 `workflow-state.yaml`（见 §6.5）；
3. **内联有序 runbook**（上表第一桶）；
4. 共享机制与逐 phase 契约仍引用（上表第二、三桶）。

> 中间路径的边界原则：**内联"序列与纪律"，引用"机制与细节"。** 序列内联杀掉遗漏；机制引用避免漂移；`aws status --next` + `aws state heal` / `aws status` 审计（CLI 层）是遗漏的第二重兜底。

**但注意（本设计的关键修正）**：薄壳只够约束 orchestrator，**不足以改变 phase skill 的行为**。`aws-explore` / `aws-case-design` 现在把「反问 + 用户批准」写死在自己的 SKILL.md 里（case-design 有 `Step 7 Get user approval — wait for explicit confirmation`、`get approval before generating any file`）。因此这两个 phase skill **必须改造成 mode-aware**：启动时读 `run_context.interaction_mode` 并分支。否则 `full` 跑起来仍会停下要批准，`full`/`two-stage` 的边界只停在文档层。

### 6.2 `aws-workflow`（`full`）需要的微调

- 明确声明：本 skill 为自主模式，explore / case-design **不反问**；对需要断言取舍的坑走 §4.2 的**透明 auto 默认策略**（标 `answered_via: auto_default`，禁止伪装成用户确认）。
- 在开头加一句指引：需要人工把关设计意图时，改用 `aws-intake` + `aws-execute`。

### 6.3 `aws-intake`（阶段一）

- 拥有 phase：Phase 0 bootstrap → explore → case-design → case-review →（needs_fix 时）case-fix 循环。
- explore Step 5 逐坑反问 + case-design 澄清 **在此启用**（inline，不可 dispatch）。
- **内联有序 Intake Runbook**（§6.1 中间路径）：Phase 0 → explore → case-design → case-review（含 `aws gate check`）→ case-fix 循环，逐步写明。
- 收敛条件（skill 完成条件）：`advisory.json` 无 `status=unanswered` 的 open_question（已 answered 或 deferred）且 `review/case-review.json` 的 `decision == pass`。
- 完成后提示用户：阶段一完成，运行 `aws-execute` 继续。
- **不产出新文件**；沿用现有 `advisory.json`（含 open_question 终态）/ `cases/` / `case-review.json`。

### 6.4 `aws-execute`（阶段二）

- 拥有 phase：fact-baseline → plan → plan-review → codegen → execution → inspect → (healing) → report → archive-eligibility。
- **内联有序 Execute Runbook**（§6.1 中间路径）：从 Phase 2.4 到 Phase 14 逐步写明，含每个 plan-review 后的 `aws gate check`、healing 的 `aws state heal` CLI 序列、`aws gate override` 恢复路径；逐 phase 深度契约仍引用各 phase skill。
- 保留全部硬 gate；**不反问**（异常 gate 走 `aws gate override`）。

### 6.5 Mode/Scope 传播机制（核心，机器可读、CLI 可校验）

在 `workflow-state.yaml` 顶层新增一个由 orchestrator skill 盖章的 `run_context`：

```yaml
run_context:
  orchestrator_skill: aws-workflow | aws-intake | aws-execute   # 谁在驱动
  interaction_mode: autonomous | interactive                    # 是否允许反问/要求批准
  active_scope: full | intake | execute                         # 允许执行的 phase 范围
  stamped_at: 2026-07-04T05:00:00Z
```

派生规则（**不是用户传参**，而是由所调用的 orchestrator skill 自动推导并写入）：

| orchestrator_skill | interaction_mode | active_scope |
|---|---|---|
| `aws-workflow` | `autonomous` | `full` |
| `aws-intake` | `interactive` | `intake` |
| `aws-execute` | `autonomous`（继承，仅执行段） | `execute` |

**写入方（Producer）**：orchestrator skill 在跑任何 phase 之前，第一步就写 `run_context`（通过 `aws state` 落盘，非手写）。
**读取方（Consumer）**：
- phase skill（`aws-explore` / `aws-case-design`）在自己的 preflight 读 `run_context.interaction_mode` → 分支（见 §6.6）。
- CLI 在 `aws state apply` / `aws status` 时读 `run_context.active_scope` → 校验范围（见 §10）。

> `interaction_mode` 是 orchestrator 盖的**派生状态**，不是新的用户参数，因此不违反"模式=调哪个 skill、不加 intake_mode 参数"的决定。它只是把"我在哪个 skill 里"这个事实，落成一个 phase skill 和 CLI 都能读的字段。

### 6.6 `aws-case-design` / `aws-explore` 的 mode-aware 分支

两个 phase skill 各自在 preflight 读 `run_context.interaction_mode`：

| 行为 | `interaction_mode == autonomous`（full / execute） | `interaction_mode == interactive`（intake） |
|---|---|---|
| explore Step 5 逐坑反问 | ✗ 跳过；open_question 填 `auto_default`（§4.2） | ✅ 逐条一问 |
| case-design 澄清对话（8 类） | ✗ 跳过；用 explore `test_strategy` 提案 + 默认取值 | ✅ 逐条澄清 |
| **case-design 用户批准（现 Step 7）** | **✗ 不要求；直接生成 → 交 reviewer** | ✅ 保留 Step 7 批准 |
| 发布门禁 | `aws-case-reviewer`（机器 gate，`case-review.json`） | 同左（reviewer，而非"用户点批准"） |
| 高风险逃生阀 | `case-review` 判 `human_review_required` → STOP | 同左 |

> **策略定论（回答"是否允许无用户批准的 auto case generation"）**：**允许，且这是 `autonomous` 模式的定义性行为。** 它安全，因为两种模式的 release gate 永远是 `aws-case-reviewer` 写的 `case-review.json`（与既有铁律 "User Approval Is Not a Gate Artifact" 一致），高风险 case 仍可经 `human_review_required` 停下等人。`interactive` 模式下用户在设计期参与（反问+批准），但**发布门禁仍是 reviewer JSON，不是用户批准**。

这要求对 `aws-case-design/SKILL.md` 的具体改动：
- 把现有硬性 `get approval before generating any file` / `Step 7 Get user approval` 改为 **conditional on `interaction_mode == interactive`**；
- `autonomous` 分支：读 explore `test_strategy` + `open_questions(auto_default)` → 直接生成 `proposal.md` + case delta → 交 `aws-case-reviewer`；`proposal.md` 标注 `generation_mode: autonomous`（可审计）。

---

## 7. 阶段二 preflight（替代交接 gate 与 intake-approved.yaml）

`aws-execute` 启动时先做 preflight，直接读**现有产物**，不依赖新文件：

```
preflight（aws-execute 启动时）:
  1. review/case-review.json 存在且 decision == pass        否则 STOP（阶段一未通过）
  2. explore/advisory.json 无 status==unanswered 的 open_question   否则 STOP（还有没答的反问）
  3. cases/ 非空                                            否则 STOP（无 case 可执行）
  4. tests/config.py + tests/conftest.py + tests/schema_validation.py 存在且合规则通过
     否则 STOP（指引回 aws-intake Phase 0；execute 不反问配置）
  → 全部满足 → 进入 fact-baseline
```

- preflight 就是 §6 早期草案里 `intake-handoff-gate` 的等价物，但**实现为 skill 的启动前检查**，读现有文件，不新增 gate、不新增产物、不做 sha256 冻结。
- 若担心阶段一之后 advisory/cases 被人改动，可在阶段二 preflight 加一条可选校验（例如比对 `workflow-state.yaml` 里记录的 phase 完成时间），但**默认不做**，保持轻量。

### Resume（`two-stage`）
- 阶段二由现有产物 + `workflow-state.yaml` 驱动，不依赖阶段一对话上下文。
- 新 session：直接调用 `aws-execute`，preflight 通过即从第一个 `pending` phase 起跑；不通过则回 `aws-intake`。
- 核心收益不变：**阶段二可在任意干净 session 恢复，不依赖人是否在场。**

---

## 8. open_questions 的终态记录（沿用 advisory.json）

不新增文件，直接在 `explore/advisory.json` 的 `open_questions_for_case_design[]` 上记录终态：

| 字段 | 含义 |
|---|---|
| `status` | `unanswered` / `answered` / `deferred` |
| `assertion_intent` | `assert_ideal` / `assert_known_bug` / `ignore` / `undecided` |
| `answered_via` | `aws-intake`（阶段一反问）/ `auto_default`（full 模式自动）|
| `answer_text` / `deferred_reason` | 用户答复或跳过理由 |

- 阶段二 preflight 的"无 unanswered"检查就读这里。
- `full` 模式下这些字段由 auto 策略填 `auto_default`，满足透明性纪律。

---

## 9. Schema / 状态 / DAG 变更清单

- **`workflow-state.yaml`**：新增 `run_context`（§6.5：`orchestrator_skill` / `interaction_mode` / `active_scope` / `stamped_at`）。这是 mode/scope 传播的载体，**必须由 CLI 的 `aws state` 写入，禁止手写**。
- **`docs/design/workflow-schema.yaml`**：DAG 本体基本不变（phase / gate 定义复用）。为每个 phase 增加 `owned_by`（如 `owned_by: [aws-workflow, aws-intake]`），供 CLI 校验 scope。**不新增 `intake_mode` 用户参数、不新增 `intake-handoff-gate`。**
- **新增两个 skill 目录**：`skills/aws-intake/SKILL.md`、`skills/aws-execute/SKILL.md`（薄壳，引用 `aws-workflow`；启动时盖 `run_context`）。
- **`aws-workflow/SKILL.md` 微调**：§6.2 声明 + 启动盖 `run_context(autonomous, full)`。
- **`aws-explore/SKILL.md` 改造（mode-aware）**：§4.1 open_question 生成规则 + preflight 读 `interaction_mode` → §4.2 的"反问 / auto_default"分支。
- **`aws-case-design/SKILL.md` 改造（mode-aware，关键）**：把硬性 `get user approval` / `get approval before generating any file` 改为 **`interaction_mode == interactive` 才要求**；`autonomous` 分支直接生成并交 reviewer，`proposal.md` 标 `generation_mode`。

---

## 10. CLI 变更

1. **`aws state` 盖 run_context**：新增/扩展命令，让 orchestrator skill 写 `run_context`（producer 唯一入口，禁止手写）。
2. **Scope 强制（`aws state apply --phase <p>`）**：读 `run_context.active_scope`，若 `<p>` ∉ scope（如 `aws-execute` 想 apply `case-design`，或 `aws-intake` 想 apply `execution`）→ **hard error**。这是把"某 skill 只跑自己范围"从文档变成机器强制的关键。
3. **Mode 一致性校验（`aws status` 或 `aws gate check`）**：
   - `autonomous`：所有 `open_questions[].answered_via` 必须为 `auto_default`（禁止伪造 `aws-workflow-intake` 的用户答复）；`case_design` 只有在 `case-review.json` 存在时才可 `done`（reviewer gate 在位）。
   - `interactive`：`case_design` 只有在 `open_questions` 无 `unanswered` 时才可 `done`。
4. **`aws status`**：渲染 `run_context`（orchestrator/mode/scope）+ 阶段一收敛情况（answered/deferred/unanswered）。
5. **透明性校验（可选）**：`autonomous` 下 advisory 存在 `confidence <= medium` 断言类坑但 `answered_via` 非 `auto_default` → warning。

> CLI 无法观测对话本身，但可通过**产物痕迹**（`answered_via`、`run_context`、`case-review.json` 是否在位、scope 是否越界）机械校验模式是否被遵守——这就是"不停在文档层"的落点。
> 相比最早草案，仍**砍掉了** `intake-handoff-gate`、sha256 冻结、intake-approved.yaml provenance 一整套；新增的只是轻量的 `run_context` + scope 校验。

---

## 11. 实现层关键落点（本轮补充的两个风险）

### 11.1 `active_scope` 必须进入 status/dispatch 决策层，而非只在 `state apply` 末端兜底

**风险**：`computeStatus()` 产出的 `next`（= `ready` 状态的 phase）是 orchestrator 与 `resolveNextDispatch()` 的**唯一依据**（`src/orchestration/engine.ts`）。若 scope 只在 `aws state apply --phase` 末端校验，`computeStatus` 仍会把越界 phase 放进 `next` → orchestrator dispatch → 跑到一半才在 apply 被拒（浪费一次执行、状态半污染）。

**落点**：把 `active_scope` 作为 `computeStatus` 的一等输入，像 `when` 一样在**决策层剪枝**。
- 每个 phase 在 `workflow-schema.yaml` 标 `owned_by: [<scope>...]`（`full` 覆盖全部；`intake` = explore / case-design / case-review / case-fix；`execute` = fact-baseline→archive-eligibility）。
- 新增 scope→phase 集合映射（由 `owned_by` 派生）。
- `Engine` 从 `run_context.active_scope` 读当前 scope；不在 scope 内的 phase → 新状态 **`out_of_scope`**，**从 `next` 中排除**（不进 dispatch）。
- **scope 只降级本会 `ready` 的 phase**：若某 phase 内在状态已是 `done`（produces 齐 + gate pass），即便 `out_of_scope` 也**仍报 `done`**（done 优先）；只有本会 `ready` 的 phase 才被降级为 `out_of_scope`。这是 §11.3 跨 scope 依赖满足的前提。
- `out_of_scope` 与 `pruned` 必须区分：`pruned` = 本 change 永不跑（`when` false）；`out_of_scope` = 本次 orchestrator 不该跑、留给另一个 stage。因此 `out_of_scope` **不向下级联剪枝**污染 DAG。
- `terminal` 的 `completed` 判定按 **in-scope** 计算：`aws-intake` 在其 scope phase 全 `done` 时即 `completed`，不等执行段。
- `resolveNextDispatch()` 自然只见到 in-scope 的 ready phase。
- `state apply` 的 scope 校验**保留为 backstop**（纵深防御），主强制在 computeStatus/dispatch。

> 决策层剪枝 + 末端 hard error 双层，呼应 §14 已决定第 7 条。

### 11.2 advisory 新 OQ 字段必须同步进 schema + validator

**风险**：§4 / §6.6 给 `open_questions_for_case_design[]` 增了 `status` / `answered_via: auto_default` 等字段。现有 `src/risk/validate_advisory.ts` 的 `checkAssertionPropagation` 只在 `answer != null && answered_via === 'explore'` 时做传播校验（`auto_default` 会被直接跳过），且完全不认识 `status`。不同步 → autonomous 的 auto 断言不被传播校验、新字段无任何约束，等于 `full` 的自动决策脱离质检。

**落点**（`src/risk/validate_advisory.ts` + `src/risk/types.ts` + `aws-explore/SKILL.md` 的 Context Contract）：
1. **字段 enum 校验**：`status ∈ {unanswered, answered, deferred}`；`assertion_intent ∈ {assert_ideal, assert_known_bug, ignore, undecided}`；`answered_via ∈ {explore, auto_default, aws-intake}`（最终枚举待锁）。
2. **status / 字段一致性**：`answered` → `assertion_intent` 与 `answered_via` 已设，且非 `auto_default` 答案需有 `answer` 或 `answer_text`；`unanswered` → `assertion_intent` / `answered_via` 空；`deferred` → 有 `deferred_reason`。
3. **传播校验扩展**：`checkAssertionPropagation` 触发条件从 `answered_via === 'explore'` 扩展到 **`answered_via ∈ {explore, auto_default, aws-intake} 且 status == answered`** —— `auto_default` 的断言必须与 explore/interactive 一样传播进 `priority_hints[].assertion_intent` / `open_question_ref`。
4. **新增 §4.1 规则校验**：`confidence <= medium` 且 hint 含断言方向的 `priority_hint`，必须有 linked 的 `open_question`（`pitfall_ref` 指向它）；缺失 → error。这条把"低置信断言必须成为反问项"从文档变成 validator 强制。
5. `aws-explore/SKILL.md` 的 Context Contract（advisory schema 说明段）同步登记以上字段与约束。

### 11.3 跨 scope 依赖 + run_mode × scope 组合规则（否则 `aws-execute` 会被自己的前置 phase 在 DAG 层卡死）

**问题**：`aws-execute`（scope=execute）入口 `fact-baseline requires: [case-review]`，`api-plan requires: [fact-baseline]`……而 `case-review` / `case-design` 属 **intake scope**。若 `out_of_scope` phase 被当作"未完成/不参与评估"，execute 的每个跨 scope 依赖都判 `blocked` → `aws-execute` 在 DAG 层直接卡死。

**规则 1 — `out_of_scope` 仍参与 done 评估（关键）**：
`out_of_scope` 语义是"**当前 orchestrator 不可运行**"，不是"不存在"。因此依赖满足**只看上游 done-ness，与上游是否 in-scope 正交**：
- 上游 `out_of_scope` 但已 `done`（前一 stage 完成，产物在磁盘 + state 标记）→ **满足**下游 in-scope phase 的 `requires`；
- 上游 `out_of_scope` 且**未** done → 下游判 `blocked`——这正是"前一 stage 没跑完"的信号，由 `aws-execute` 的 preflight（§7）**提前**拦下并指引"回去跑 `aws-intake`"，而不是无声卡在 DAG。

**规则 2 — 三维状态判定顺序**（run_mode / scope / deps 正交）：
1. `pruned`（run_mode `when` 为假）→ 本 change 永不跑；`produces` 若存在仍可满足下游（沿用现有 codegen-only 语义）。
2. `out_of_scope`（未 pruned 但不在 `active_scope`）→ 本 orchestrator 不跑，但按规则 1 参与 done 评估。
3. 其余：in-play ∧ in-scope ∧ deps-done → `ready`（进 `next`）。

**规则 3 — run_mode × orchestrator_skill 合法组合矩阵**（`aws state` 盖 run_context 时校验，非法组合 hard error）：

| orchestrator_skill | 允许的 run_mode | active_scope |
|---|---|---|
| `aws-workflow` | full / case-only / api-only / e2e-only / plan-only / codegen-only / review-case / review-plan | full |
| `aws-intake` | full / case-only / review-case | intake |
| `aws-execute` | full / api-only / e2e-only / plan-only / codegen-only / review-plan | execute |

- 非法组合（如 `aws-intake + codegen-only`、`aws-execute + case-only`）→ 盖章即 hard error。
- `aws-execute + 任一 run_mode`：intake 段 phase 恒 `out_of_scope`，其 done-ness 由 `aws-intake` 阶段留下的产物提供（规则 1）。

**规则 4 — 组合边界的 produces 回退**：当某上游 phase 同时 `out_of_scope`（execute 视角）**且**在 run_mode 下 `pruned`（如 codegen-only 下 case-design/plan 被 `when` 剪掉），下游依赖满足回退到 **produces-present**（现有 codegen-only 已如此）；scope 维度不改变这条回退。

> 一句话：**`out_of_scope` 管"我能不能跑"，`done`/`produces` 管"能不能满足别人的依赖"，两者解耦。** 这样 `aws-execute` 的跨 scope 前置不会被误判 blocked，未完成时也有 preflight 给出明确指引。

---

## 12. 迁移与向后兼容

- `aws-workflow`（`full`）行为不变，仅补 auto 决策透明标注 + 指引。现有 change 完全不受影响。
- `two-stage` 是纯新增能力：想用就调用两个新 skill；不用则一切照旧。
- 阶段二 preflight 只读现有产物，已有 change 无需迁移。
- **注意**：本设计的改动面比"两个薄壳"更大——`aws-case-design` / `aws-explore` 需改成 mode-aware，且需引入 `run_context` + CLI scope/mode 校验。这是"让边界真正跑起来"的必要成本。
- 引入顺序：
  1. **`run_context` 机制**：`aws state` 写入 + `workflow-state.yaml` 字段 + `aws status` 渲染（先立传播载体）；
  2. **`active_scope` 进决策层（§11.1 + §11.3）**：`workflow-schema.yaml` 加 `owned_by`；`Engine.computeStatus` 支持 `out_of_scope`（done 优先，仍参与依赖满足）；`next` 排除越界 phase；`resolveNextDispatch` 天然只见 in-scope；`aws state` 校验 run_mode×scope 组合矩阵；`state apply` 保留 backstop；
  3. **advisory OQ schema + validator（§11.2）**：`validate_advisory.ts` 扩展 status/enum/传播/低置信必问校验；`aws-explore` Context Contract 同步字段；
  4. **`aws-case-design` / `aws-explore` mode-aware 改造**：读 `interaction_mode` 分支（`autonomous` 免批准 auto 生成 / `interactive` 保留反问+批准）——直接决定 `full` 能否真正一口气跑完；
  5. `aws-workflow` 微调 + 启动盖 `run_context(autonomous, full)`；
  6. 新增 `aws-intake`（盖 `interactive, intake`，启用反问）；
  7. 新增 `aws-execute`（盖 `autonomous, execute` + preflight）。

---

## 13. 本设计解决 / 不解决

| 问题 | 是否解决 | 说明 |
|---|---|---|
| 问题 1：反问被跳过 / auto 决策不透明 | ✅ | `full` 透明 auto；`two-stage` 由 `aws-intake` 显式反问，阶段二 preflight 硬拦 `unanswered` |
| 模式期望错配 | ✅ | 模式 = 调哪个 skill，选择显式 |
| **mode/scope 停在文档层** | ✅ | `run_context` 传播 + phase skill mode-aware + CLI scope/mode 校验，机器可校验 |
| **scope 只在末端兜底** | ✅ | `active_scope` 进 `computeStatus` 决策层，越界 phase 不进 `next`（§11.1）+ apply backstop |
| **`aws-execute` 被跨 scope 前置卡死** | ✅ | `out_of_scope` 仍参与 done 评估 + run_mode×scope 组合矩阵 + preflight 指引（§11.3） |
| **advisory 新 OQ 字段无约束** | ✅ | schema + validator 同步 status/enum/传播/低置信必问（§11.2） |
| **auto case generation 策略未定** | ✅ | 明确：`autonomous` 允许免批准 auto 生成，reviewer 兜底（§6.6） |
| 断点续跑脆弱（two-stage） | ✅ | 阶段二由现有产物驱动 + preflight，可任意 session 恢复 |
| 问题 2：healing 状态被绕过 | ❌ | 见 [state-machine-enforcement.md](./state-machine-enforcement.md) §4 |
| 问题 3：gate JSON 被伪造 | ❌ | 见 [state-machine-enforcement.md](./state-machine-enforcement.md) §3、§5 |

> 结论：`full` 保持快车道、`two-stage` 用两个薄 skill 提供设计把关，两者都保留硬 gate 且执行语义单一来源（`aws-workflow`）；mode/scope 经 `run_context` 落到机器可校验层，phase skill 真正按模式分支。整体稳定性的真正瓶颈仍是执行阶段的状态机机械强制，需配套 [state-machine-enforcement.md](./state-machine-enforcement.md)。

---

## 14. 决定与开放问题

### 已决定
1. **命名**：两个新 skill 为 **`aws-intake`**（阶段一）/ **`aws-execute`**（阶段二）。
2. **阶段交接**：**选项 1 —— 阶段一跑完即停，用户显式调用 `aws-execute` 继续**（两次调用）。理由：反问答案已持久化在 `advisory.json`，分两次不丢信息，却换来 context 干净、可换 session 续跑、阶段二可 dispatch。`aws-intake` 结束时打印下一条命令（`aws-execute --change <id>`）降低操作成本。想要"不反问一条龙"用 `full`；不提供 two-stage 内的自动接续（避免与 `full` 冗余、避免 context 膨胀）。
3. **mode/scope 传播机制**：新增 `workflow-state.yaml.run_context`（`orchestrator_skill` / `interaction_mode` / `active_scope`），由 orchestrator skill 经 `aws state` 盖章（派生自"调哪个 skill"，非用户参数），phase skill preflight 读取分支，CLI 校验 scope/mode（§6.5 / §10）。
4. **auto case generation 策略**：**`autonomous`（full/execute）允许无用户批准的 auto case generation**；release gate 恒为 `aws-case-reviewer`（`case-review.json`），高风险经 `human_review_required` 停下。`interactive`（intake）保留 case-design 的反问 + Step 7 批准。`aws-case-design` / `aws-explore` 因此改造为 **mode-aware**（§6.6）。
5. **薄壳的复用方式**：**A —— 新 skill 引用 `aws-workflow` 的章节**（规格单一来源、不漂移）；薄壳内需写清"引用哪些段"。
6. **`full` 下 auto 决策的默认断言策略**：**ideal-behavior 类坑默认 `assert_ideal`**（无法判定的坑留 `undecided`，case-design 用中性措辞）。
7. **scope 校验强制力度**：**`aws state apply` 越界一律 hard error**（彻底机器强制，不设 warning 档）。

### 待定
8. **deferred 跨 change 记忆**：暂列 backlog，先不做。
