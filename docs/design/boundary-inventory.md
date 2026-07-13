# 边界清单与治本设计:从流程管制到「目标 · 边界 · 裁决 · 评估」

> 起因:RET-* 四 change 基准运行中,所有阻塞均来自状态机自锁而非 agent 危险行为;
> CLI 盘点(14 顶级命令 / 35 子命令)显示修补集中在人工裁决(5 套入口)与 healing 状态机(3 个内脏命令)。
> 本文先归因,再给一套治本的目标架构与测试计划。冗余代码与旧入口一律直接删除,不保留兼容层。

---

## 1. 根因分析

四天基准运行的全部事故,归结为五个结构性根因:

| # | 根因 | 症状(实例) |
|---|---|---|
| R1 | **状态与证据双写**:workflow-state.yaml 存可变 status,events/工件存证据,二者会漂移 | `HEAL-STATE-INCONSISTENT`;为救漂移又长出 `state heal --reconcile`(补丁的补丁) |
| R2 | **裁决入口碎片化且有假承诺**:5 套人工裁决语法,消费语义各异 | `gate override` 4 个 action 只消费 1 个;`accept_and_stop` 静默无效浪费一轮排障 |
| R3 | **状态缺出口**:转移合法性穷举 + 每边挂前置条件,组合出死角 | menu 卡 `proposal_created`:applied 被安全门堵、failed 要手写 error 文件、exhausted 非法 |
| R4 | **审计许可优先而非证据优先**:转移必须"长得像机器干的" | 人已 override 且亲手修复,仍需手术式往 events.jsonl 插 `phase_dispatched` 才能过审 |
| R5 | **driver 微编排**:resume 恢复逻辑按状态逐个 special-case | `findPendingReviewOverride` / `findPendingHumanReviewPause` / healing 恢复块各管一段;`proposal_created` 没人管 → 死循环 exit 40 |

共同模式:**每次状态机堵死,就长出一个新命令、新旗标或新转移边**,而不是收敛到通用机制。复杂度在过程管制侧持续增生,而系统真正的价值(确定性内核 status/gate check/run/report + 评估环路 retro/eval)并不依赖这些增生物。

## 2. 判定原则

对每一个硬门禁问三个问题:**不可逆吗?机器判断可靠吗?有出口吗?**
只有「不可逆伤害」与「证据链完整性」两类保留硬边界;其余一律降级为「证据 + 裁决」。

反模式试金石(均为本基准真实事故):逃出状态需手写 JSON 满足前置;放行评审需手术插事件;CLI 记录人类决定但引擎永不消费;检查因基线时序假设错误误报且无裁决通道。

---

## 3. 治本设计:五个支柱

### 支柱 1 —— 统一裁决协议 `aws decide`(解 R2)

所有人类决定收敛为一条命令、一种事件:

```
aws decide --change <id> --at <checkpoint> --action <action> --reason <text> [--evidence <path>]
```

- `--at`:检查点标识 = gate id / phase id / `healing.safety` / `execution.test-changes` / `bootstrap` …
- `--action`:`fix_and_proceed` | `accept_risk` | `skip_branch` | `stop` | `allow_test_changes` …
- 落一条 `human_decision` 事件:who / reason / checkpoint / 绑定被裁决工件的 sha256(沿用今日 `review_sha256` 机制,防"先放行后偷改")。
- **记录即承诺**:CLI 在记录时校验引擎对 `(checkpoint, action)` 组合存在消费者,否则当场拒绝。从机制上杜绝 `accept_and_stop` 式假承诺。

旧入口**直接删除**:`gate override`、`run --allow-test-changes`、`state bootstrap-override` 整体移除,调用方(skills、runbook、driver)一次性切到 `decide`。`report reclassify` 因带结构化参数保留原语法,但底层改发 `human_decision` 事件。

### 支柱 2 —— 裁决进入状态推导(解 R4、R5 的一半)

关键改变:**gate 的有效裁决 = f(工件, 决定)**,而不是只读工件。

- `gate check` 解析 verdict 时读取该 checkpoint 的最新 `human_decision`:
  `needs_human_review` + `accept_risk` → 有效 verdict `pass`(带 decision 标注);+ `stop` → `stop`;+ `fix_and_proceed` → `needs_fix`(推荐修复 phase)。
- 审计规则同步改为证据优先:`human_decision` 事件与 `phase_dispatched` 同权,是合法的 repair/放行证据。`GATE-TRANSITION-ILLEGAL: needs_human_review→pass` 的判定条件从「override **且** repairDone」改为「override 即可」。
- 直接后果:driver 的 `findPendingReviewOverride` / `findPendingHumanReviewPause` 两个恢复块**直接删除**——resume 后 status/gate 推导天然给出正确下一步,无需 driver 记住"人上次说过什么"。

### 支柱 3 —— 通用出口 `stop`(解 R3)

`aws decide --action stop`:从**任何非终态**合法落到 `stopped`,写入终止事件(who/why/state-at-stop),**不要求任何前置工件**。

- 一次性消灭「状态死结」类事故:menu 三出口全堵场景 → 1 条命令。
- healing 专项放宽随之简化:`failed` 不再要求 `*-fixer-error.json` 存在,由 CLI 代写规范化 error 记录(人只给理由,不伪造工件);`proposal_created → exhausted` 转移边**直接删除**——统一走 stop。
- 设计不变量从此成立:**任何状态必有一条成本 ≤ 1 条命令、不需伪造工件的人工出口。**

### 支柱 4 —— healing 状态从证据推导(解 R1)

phase 状态早已是推导的(`status` 从 schema+工件确定性计算),healing 却是双写的——这就是漂移的来源。目标:

- healing 状态 = f(工件, 事件, 决定):proposal 在 → `proposal_created`;apply-summaries 齐 + 安全检查通过(或 `accept_risk` 决定)→ `applied`;rerun+reinspect 清 → `resolved`;`stop` 决定 → 终态;attempts 从 `heal_record_apply` 事件计数。
- `state heal --reconcile` **直接删除**(状态不再可能与证据漂移);`state heal --to` 收缩为仅记录**判断型**结论(`resolved`/`not_needed` 这类需要 orchestrator 判断的),机械可推导的转移边全部删除。
- 安全检查修正:`unrelated_tests_modified` 的基线从 execution 快照改为 **healing 进入时刻 pin 的测试树**,消除 post-execution codegen 误报;检查失败不再是死墙,verdict = `needs_human_review`,由支柱 1 裁决。

### 支柱 5 —— driver 瘦身 + CLI 直接删减(解 R5)

driver 主循环收敛为三步:**推导(status)→ 派发(dispatch)→ 验收(gate check)**。所有恢复逻辑由支柱 2/4 的推导天然覆盖,special-case 恢复块(loop.ts 约 304–429 行)直接删除。

CLI 删减(全部直接删除,不留 alias、不留 deprecation 期):

| 动作 | 项 |
|---|---|
| 删除 | `workflow resume`;`gate override` 全部(由 decide 接管);`run --allow-test-changes`;`state bootstrap-override`;`state heal --reconcile`;`workflow start`(并入 `workflow run` 的 adapter 路径);`state stamp-run-context`(并入 `state configure`) |
| 内化 | `state apply --min-mtime-ms` / `--skill-md-path`(3 处重复):driver 自动注入,选项从 CLI 面上移除 |
| 保留 | 确定性内核(status / gate check / run / report inspect·generate / risk)与评估环路(retro / eval)全族;`heal record-apply`(CLI-owned 证据,方向正确) |

同步义务:删除入口时,引用它们的 skills(`skills/aws-*/SKILL.md`)、`.opencode/agents`、runbook、`scripts/*.mjs` 在同一 PR 内更新,禁止留下指向已删命令的文档。

## 4. 保留的硬边界(全部通过三问检验)

| 门禁 | 理由 |
|---|---|
| `PRODUCT-CHANGED-DURING-HEALING` | healing 改产品代码不可逆污染 SUT |
| `ARTIFACT-TAMPERED` / `RECLASSIFY-WITHOUT-EVENT` | 证据链完整性 |
| H0(agent 不得写 workflow-state) | 所有权边界,只有 reducer 可写 |
| codegen 硬门不可 override | 纯机械存在性检查,override 无意义 |
| `TEST-CHANGES-OVERRIDE-TOKEN-*` 一次性令牌思想 | 防授权重放;decide 的 sha256 绑定沿用同一思想 |
| `GATE-TRANSITION-ILLEGAL: reject→*` | reject 是终审,复活走新 change |

范本认定:「硬检查 + 单命令出口 + 审计留痕」是支柱 1 的原型形态,推广其形态而非发明新形态。

## 5. 测试计划

分四层,自下而上;基准场景全部来自本次四 change 运行的真实事故,作为回归锚点。

### 5.1 单元测试(每支柱一组)

| 支柱 | 测试点 | 位置 |
|---|---|---|
| decide 协议 | `(checkpoint, action)` 无消费者时记录被拒绝;事件含 who/reason/sha256;被裁决工件事后被改 → sha256 失配可检出 | `tests/unit/core/decide.test.ts`(新) |
| gate 推导 | `needs_human_review` + `accept_risk`→`pass`、+`stop`→`stop`、+`fix_and_proceed`→`needs_fix`;无 decision 时行为与现状一致;decision 早于最新工件(过期裁决)不生效 | `tests/unit/driver/gate_router.test.ts` 扩展 |
| stop 出口 | 从每一个非终态(含 `proposal_created`、`awaiting_gate`、`needs_human_review`)stop 均合法落 `stopped`;终态上 stop 被拒绝;不要求任何前置文件 | `tests/unit/core/decide.test.ts` |
| healing 推导 | 给定工件组合(proposal/apply-summaries/safety/rerun/decision)推导出唯一状态;attempts 从事件计数;推导函数为纯函数、同输入同输出 | `tests/unit/core/healing_state.test.ts` 重写 |
| 安全基线 | 构造「execution 快照早于 e2e-codegen 产物」的树:修复后 `unrelated_tests_modified=false`;真越权改动(改提案外 api 测试)仍 `true` | `tests/unit/core/healing_state.test.ts` |
| 审计证据优先 | `human_decision` 作为 repair 证据使 `needs_human_review→pass` 合法;无任何证据时仍非法 | `tests/unit/core/audit.test.ts` 扩展 |

### 5.2 契约测试(删除项的负向验证)

- 已删命令(`gate override`、`workflow resume`、`state heal --reconcile`、`state bootstrap-override`、`run --allow-test-changes`、`state stamp-run-context`、`workflow start`)调用即报错且错误信息指向 `decide`/`run` 的等价用法。
- 代码库全文无对已删命令的引用:`rg` 检查 skills/、.opencode/、scripts/、docs/ 零命中(CI 步骤)。
- `LEGAL_TRANSITIONS` 中被删除的边(如 `proposal_created→exhausted` 手动径)不再可达。

### 5.3 基准场景回归(事故重放,driver 级)

| 场景 | 原事故 | 通过标准 |
|---|---|---|
| S1 menu 死结 | healing 卡 `proposal_created`,三出口全堵,resume 反复 exit 40 | `aws decide --action stop` 1 条命令落 `stopped`;或 `accept_risk` 后 driver 续跑至终态;全程无手写 JSON |
| S2 api-mgmt 插事件 | `needs_human_review→pass` 需手术插 `phase_dispatched` | override 决定后审计直接通过,events.jsonl 无人工插入 |
| S3 假承诺 | `accept_and_stop` 记录后静默无效 | `decide --action stop` 记录即消费,driver 下一轮落终态 |
| S4 安全门误报 | post-execution codegen 触发 `unrelated_tests_modified` | 同版图重放:安全检查 pass,healing 正常走完 |
| S5 resume 幂等 | `proposal_created` 上 resume 死循环 | 任意状态连续 resume 两次:第二次为 no-op 或正常推进,永不 exit 40 自转移 |

实现方式:不复制场景夹具,直接把事故断言固化到对应职责的既有测试:
S1/S3 在 `tests/unit/core/decide.test.ts`,S2/S5 在
`tests/unit/driver/loop.smoke.test.ts` 与 `healing_subroutine.test.ts`,S4 在
`tests/unit/core/healing_entry_baseline.test.ts`。全部使用临时目录/fake runner,不依赖真实 SUT。

### 5.4 端到端验收

- `scripts/eval-workflow-run.mjs` 全量五 change 基准跑通:终态分布不劣于本次(≥3 completed);人工干预点全部 ≤ 1 条命令。
- 现有全量单测/集成测试通过;driver `loop.ts` 与 `healing_state.ts` 行数**净减少**(在 PR 描述中记录 before/after)。

## 6. 复杂度预算(防复发)

今后任何 PR 新增 `LEGAL_TRANSITIONS` 边、gate 前置条件、override action、resume special-case,必须先回答:**能否用 decide 协议 + stop 出口 + 证据推导替代?** 默认答案是能;答不出写进 PR 描述,由评审把关。出问题时优先问"该往 memory/eval 加什么",而不是"该往 driver 加什么判断"——本基准的经验:memory 修复在规模化产生收益(retro 8 提案 6 可落地),driver 修复在繁殖更多 driver 修复。

## 7. 实现状态（concentrate-workflow-progression round-2）

- **R4（审计许可优先）**: `human_decision` 与 `dispatch_signed` 已作为合法 repair/放行证据纳入 `audit.ts`; `gate check` 经 `inspectNamedGate` 读取 decision 推导 verdict,不再要求手术式插 `phase_dispatched`。
- **R5（driver 微编排）**: `loop.ts` 主循环收敛为 `inspect → dispatch → advance`; resume 恢复 special-case 已删除,`CliExitCodes` 统一 CLI/driver 出口语义。

