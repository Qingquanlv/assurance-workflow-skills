# Nightly Driver：PHASE A–F 编排、PHASE F 验证通路与 nightly 报告

> 本文是 `retro-self-improvement-loop.md` §12 第 6、7、8 项的详细设计。
> 父 spec 定义"闭环应该是什么"；本文定义"driver 怎么把它跑起来"。
> 依赖的底层原语（`aws retro` / `promote` / `apply` / `rollback`、`_state.json`、
> retro 目录不可变守卫、`aws eval run --extra-memory-dir`）均已实现。

---

## 0. 范围与非目标

覆盖：

1. **nightly driver 命令**：编排 PHASE A–F，停在 PHASE D 输出人审队列，人决策后续跑 E–F（父 spec §5）。
2. **PHASE F 验证通路**：overlay 构造、基线对照跑法、回归判定（引用 `eval/contracts/p0-metrics.yaml`）、`eval_run_id` 跨仓库回填、回滚触发。
3. **nightly 报告**：signal_count 趋势、决策统计、连续 needs_rework 告警。

非目标：

- 不改内层 workflow（benchmark 脚本 `run-workflow-loop-cursor.sh` 继续负责"生产证据"，本 driver 只消费）。
- 不实现 `contract_field` / `schema_*` 的自动落地（维持父 spec §8：只产 PR 建议）。
- 不实现真正的 crontab/CI 调度（driver 是可被任何调度器调用的幂等命令；调度配置另行处理）。

---

## 1. 拓扑与执行位置

driver 跨两个仓库工作，**编译在 skills 仓库的 `aws` CLI 中**，原因：

- PHASE F 要跑 `aws eval run`，eval harness（suites/datasets/baselines/runs）只存在于 skills 仓库；
- PHASE C 要校验 proposal target 对应的 skill 真实存在（`skills/<name>/SKILL.md`）；
- SUT 侧只有证据（`qa/`），通过 `--sut <path>` 参数指入。

```
skills 仓库 (driver 所在，PHASE C/F 在此执行)
├── src/retro/nightly/               # 编译后的 driver 与 PHASE A–F 模块
├── eval/{suites,baselines,contracts}/
├── eval/out/{runs,batches,reports}/
└── skills/*/SKILL.md

SUT 仓库 (证据与 retro 产物所在，PHASE A/B/D/E 的读写目标)
├── qa/archive/<change-id>/
├── qa/changes/<change-id>/
├── qa/retro/<retro-id>/{context,proposals,promotions}.json
├── qa/retro/<retro-id>/evidence/<change-id>/
├── qa/retro/<retro-id>/review-queue.md      # 本文新增
├── qa/retro/<retro-id>/nightly-report.md    # 本文新增（+ .json）
├── qa/retro/_state.json
└── .aws/memory/aws-*.md
```

所有对 SUT 的 CLI 调用（`aws retro` 系列、`aws status`）以 SUT 为 cwd 执行；
所有 eval 调用以 skills 仓库为 cwd 执行。driver 内部不得混淆两个 cwd。

---

## 2. Driver 形态：两段式命令

PHASE D 是人审门禁，可能跨数天——driver 不能是一个从头阻塞到尾的进程。
拆成两个幂等子命令，中间以 `qa/retro/<rid>/` 里的文件为唯一状态载体：

```
aws retro nightly collect --sut <path> [--retro-id <rid>] [--dry-run]
    跑 PHASE A → B → C → D(生成队列后退出)
    输出：review-queue.md + 退出码(见 §8)

aws retro nightly resume --sut <path> --retro-id <rid>
    前提：人已用 aws retro promote 写完决策
    跑 PHASE E → F → 报告
    可重复执行(apply 幂等、eval 只补跑缺失的 suite)

aws retro nightly report --sut <path> [--last <n>]
    独立重新生成跨 run 报告(§7)，不改任何决策/记忆文件
```

约束：

- `collect` 不带 `--retro-id` 时由 driver 生成 `retro-YYYYMMDD-HHMMSS`（时间分量强制，父 spec §6）。
- `resume` 发现队列里仍有未决策的 proposal（proposals.json 有、promotions.json 无生效记录）→ 对这些条目跳过并在报告中列出，不视为错误；全部未决策则退出码 30（"等人"）。
- 两段各自可安全重跑：`collect` 重跑同一 `--retro-id` 会被 CLI 的不可变守卫拦下（已含 promotions.json 时）；未含时允许覆盖重建（视为上次 collect 失败重试）。

配置经命令行与环境变量传入，无配置文件：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--sut <path>` | 必填 | SUT 仓库根。**PHASE A–E 与 PHASE F 必须指向同一 checkout**（见 §2.1） |
| `--history <n>` | 5 | PHASE C 回读最近 n 个 retro run 的 promotions.json |
| `--min-evidence <n>` | 2 | PHASE D 降噪阈值（父 spec §7） |
| `--rework-alert <k>` | 3 | 连续 needs_rework 告警轮数（父 spec §7） |
| `--agent <cmd>` | `cursor-agent` | PHASE C 的 agent 引擎 |
| `--skip-eval` | false | 调试用：只做 staging 渲染并在报告标 `eval_skipped`，不写活 SUT、不回填 `eval_run_id` |

### 2.1 SUT 绑定（P0：driver `--sut` 与 eval 必须一致）

driver 的 `--sut` 是整条链路的 SUT 权威路径：PHASE A–E 的 retro/promote/apply/staging
都以此 cwd 或路径读写；PHASE E 的 `--stage-dir` 渲染也从该 checkout 读取
**当前** `.aws/memory/` 全文。

PHASE F 在 **skills 仓库** 内执行 `aws eval run`，eval harness 默认通过
`eval/suts.yaml` 的 `local_dir`（或环境变量 `EVAL_SUT_DIR`）解析 SUT
（`src/eval/sut_registry.ts`）。若 driver 的 `--sut` 与 registry 默认 checkout
不是同一目录，会出现：**staging 从活 benchmark SUT 渲染 overlay，eval 却在
另一个 checkout 上跑对照**——基线与 candidate 的 memory 基底不一致，回归判定
完全失真。

**强制契约**：driver 调用 PHASE F 的每一次 `aws eval run`（基线侧与候选侧
均包括）必须显式传入：

```bash
cd <skills> && aws eval run --suite <s> --sut-dir <sut> [--extra-memory-dir <stage-dir>] --json
```

`--sut-dir` 覆盖 registry / `EVAL_SUT_DIR`，使 eval 与 driver 使用同一
checkout。禁止依赖 registry 默认路径"碰巧相同"；nightly 脚本不得省略该参数。

**端到端传播（已实现）**：`--sut-dir` 必须在 executor、overlay、scorer
三处生效，不能只改 executor：

- **registry 短路**：`sutDirOverride` 存在时 runner **不调用**
  `resolveSampleSut`——dataset 样本普遍带 `sut: fastapi-vue-admin`，若先解析
  registry 而 `local_dir` 缺失或与 driver checkout 不一致，会在 override
  生效前抛错或发出基于 registry 的错误警告。override 时直接使用 driver 路径。
- **executor**：`runSuite` 将 override 作为 `sutDir` 传入 `executeAttempt`
  （`{{sut.dir}}` 模板变量）。
- **overlay**：`snapshotMemoryDir` / `applyExtraMemoryOverlay` 在同一
  `effectiveSutDir` 上操作。
- **scorer**：`runScorer` 通过 `applySutDirOverride` 改写 sample（去掉
  `input.sut`、设绝对路径 `input.project_dir`），使 workflow codegen scorer
  的 `resolveSampleProjectDir(input)` 与 executor 同源。`resolveSampleProjectDir`
  亦接受第三参 `sutDirOverride` 作为最高优先级兜底。

workflow_run / workflow_full / workflow-case 等 scorer 只读 attempt 产物，
不解析 SUT 目录，无需 override。

备选（不推荐）：在 eval 子进程前 `export EVAL_SUT_DIR=<sut>`。效果等价但
不可从 CLI 日志审计、易被父进程 env 污染；优先 `--sut-dir`。


## 3. PHASE A：采集（driver 是 change 清单的唯一权威）

输入：SUT 的 `qa/archive/`、`qa/changes/`、`qa/retro/_state.json`。

算法：

```
1. 读 _state.json → consumed = {(change_id, source)}
2. 候选枚举：
   a. qa/archive/ 下所有目录 → source=archive
   b. qa/changes/ 下所有目录 → source=unarchived，且仅当同名 archive 不存在
      （archive 存在时 reader 会优先读 archive，unarchived 候选无意义）
3. 过滤：
   - (id, source) ∈ consumed → 跳过（幂等，父 spec §6 的按源去重：
     unarchived 消费过、后来出现 archive 的允许以 archive 身份再进一次）
   - source=unarchived 的候选：执行 `aws status --change <id>`（SUT cwd），
     exit 10(completed)/20(stopped) → 保留；exit 0(运行中) → 剔除。
     禁止 driver 或 reader 自行从 workflow-state.yaml 推导 terminal。
4. 证据完整性校验（父 spec §4 四类文件）：
   events.jsonl 必须存在；workflow-state.yaml 必须存在；
   inspect/failure-analysis.json 与 healing/ 允许缺（healthy run 没有）。
   events.jsonl 缺失 → 标 evidence_incomplete，记入报告，不进 PHASE B 清单。
5. 快照（仅 source=unarchived）：
   复制四类文件到 qa/retro/<rid>/evidence/<change-id>/
   （qa/changes/ 是过程目录，benchmark 每轮开跑前会清理；
    PHASE D 人审可能持续数天，必须落快照）
6. 产出本轮清单 changes[] = [(id, source)]；为空 → 退出码 10（无事可做），
   不写 _state.json、不创建 retro 目录。
```

与现状的一处对齐要求（实现时一并修）：目前 `context.json` 的
`window.change_sources[].path` 对 unarchived 指向活的 `qa/changes/<id>`。
driver 快照后该路径在人审期间可能失效。**修改 `aws retro`：当
`qa/retro/<rid>/evidence/<change-id>/` 存在时，`change_sources[].path`
指向快照路径**（聚合器读取仍走原路径，仅展示路径替换）。

## 4. PHASE B：聚合

```
cd <sut> && aws retro --retro-id <rid> --change <id1> --change <id2> ... --json
```

- 一律走 `--change` 显式清单，禁用 `--since`（父 spec §5 PHASE B 的理由：
  `--since` 自行重扫、无法感知 PHASE A 的剔除与去重结果）。
- **consumed 两段式记账（防证据丢失）**：`aws retro` 聚合成功后写
  `_state.json`，但记录带 `stage: "aggregated"`——此时 change 尚未被
  "真正消费"。collect 全链路成功（review-queue.md 落盘）后，driver 执行
  `aws retro complete --retro <rid>` 把该 retro run 的记录升级为
  `stage: "collected"`。PHASE A 的去重规则相应分级：
  - `stage=collected` 的 `(id, source)` → 跳过（终态消费）。
  - `stage=aggregated` 的 `(id, source)` → **允许重放**：说明上一轮 collect
    在 PHASE C/D 中途失败（agent 崩溃、proposals 校验全灭、队列未落盘），
    证据不能丢。重放时记录的 `retro_id`/`consumed_at` 更新为新 run。
  - 无 `stage` 字段的旧记录 → 视为 `collected`（保守，避免重复消费
    staging 机制之前已处理过的 change）。
- `signal_count == 0` → driver 提前收尾：不跑 C–F，写报告（"no-op run"），
  退出码 10，并执行 `aws retro complete`——无信号是合法终态，
  这批 change 不需要再看第二遍。

## 5. PHASE C：提案（agent 调用）

driver 用 `--agent` 指定的引擎唤起 `aws-retro` skill：

```
prompt 契约（与 benchmark 脚本 retro_proposals_prompt 对齐）：
  - Use skill aws-retro.
  - Input: qa/retro/<rid>/context.json
  - Read-only history: 最近 --history 个 retro run 的 promotions.json
    （driver 负责把这批文件路径列进 prompt，不让 agent 自己扫目录）
  - Output: qa/retro/<rid>/proposals.json + retro-summary.md
```

agent 退出后 driver 立即做机器校验：

1. `proposals.json` 存在且可解析；缺失 → 退出码 40（agent 失败）。
2. `validateRetroProposals(context, proposals)` 全过；有错 → 将出错 proposal
   剔除出队列并记入报告（不整轮失败——一条畸形提案不应废掉全部产出）。
3. 提案数为 0 → 与 signal_count==0 同路径收尾（合法结果，不是错误）。

## 6. PHASE D：人审队列

driver 生成 `qa/retro/<rid>/review-queue.md`，随后退出（码 0）。格式沿用
父 spec §7 的条目模板，外加 driver 侧预处理：

- **降噪**：`evidence_ids` 涉及的 change 数 < `--min-evidence` → driver 直接
  `aws retro promote --decision needs_rework --by driver --note "evidence below threshold (<n>)"`,
  不进人审队列，仅在队列末尾"自动处理"小节列出。
- **非 memory_append**：`apply_kind != memory_append` 的条目在队列中标注
  `[PR-ONLY]`，人仍可 promote，但 PHASE E 对它只在报告中产出 PR 建议文本，
  不写任何文件。
- **升级告警**：同源提案（同 target + problem 语义等价，判定实现见 §7 报告节）
  连续 `--rework-alert` 轮被标 needs_rework → 队列条目头部加 `[STUCK x<k>]`。

人用现有 CLI 决策（driver 不提供交互界面）：

```
cd <sut> && aws retro promote --retro <rid> --proposal RETRO-001 --decision promoted --by <who>
```

## 7. PHASE E：staging 渲染（验证先行，不先写活 SUT）

> 顺序修正：早先版本"先 apply 到 SUT、再跑 PHASE F 对照"存在 P0 缺陷——
> eval 的 SUT 工作区（`eval/suts.yaml` 的 `local_dir` 持久 checkout，甚至可能
> 与活 SUT 是同一目录）在基线侧就已含新规则，基线被污染、candidate overlay
> 沦为冗余，回归判定失真。因此改为**验证先行**：PHASE E 只做无副作用的
> staging 渲染，真正写 SUT 的 apply 移到 PHASE F 通过之后。

`resume` 对每条生效决策为 promoted 且 `apply_kind=memory_append` 的提案执行：

```
cd <sut> && aws retro apply --retro <rid> --proposal <pid> --stage-dir <overlay-dir>
```

- **`--stage-dir <dir>`（需新增）**：渲染模式。把"SUT 当前 memory 文件全文
  + 本提案新块"写入 stage 目录（按 target 文件名落盘），**不写 SUT 的
  `.aws/memory/`**。渲染复用 apply 的既有块格式与幂等键逻辑，避免 driver
  另行拼装导致两套渲染漂移。
- 复制全文而非仅新块的原因：memory 是累积语义，验证的是"当前记忆全集
  +新规则"的效果；`deprecated:` 条目无需剔除（消费契约只应用未标
  deprecated 的条目）。
- 逐条 `--proposal` 而非整轮：便于把失败隔离到单条。
- 现状缺陷（实现时一并修）：`apply` 目前对 proposals.json **全部**提案跑
  `validateRetroProposals`，一条畸形会阻塞其余合法提案。**改为只校验本次
  被选中的提案**；未选中提案的校验错误降级为 stderr 警告。

---

## 8. PHASE F：验证通路（§12 第 7 项详细设计）

### 8.1 Overlay 即 stage 目录

PHASE E 的 `--stage-dir` 输出就是 candidate overlay，driver 不再从 SUT 反向
拷贝。stage 目录随 resume 进程 mktemp 创建、跑完删除。

### 8.2 跑法：按 suite 批量对照

同一 suite 的多条 proposal 合并为一次对照（父 spec §9.3，控制成本）：

```
分组：promoted proposals 按 eval_suite 分组；每组共用一个 stage 目录
     （组内各 proposal 依次以 --stage-dir 渲染进同一目录，块级幂等键防重）
对每个 suite s：
  基线侧：优先复用 eval/baselines/main.json 中 s 的既有条目；
          无条目时先跑一次
          `cd <skills> && aws eval run --suite s --sut-dir <sut> --json`
          并将其 metrics 记为本次对照的临时基线（不写入 baselines/，
          基线入库仍走人工 `aws eval baseline update`）
  候选侧：cd <skills> && aws eval run --suite s --sut-dir <sut> \
            --extra-memory-dir <stage-dir> --json
```

`--sut-dir` 与 §2.1 绑定：两次 run 必须使用 driver 传入的同一 `<sut>`，
确保 staging 渲染所依据的 live memory 与 eval 工作区 checkout 一致。

前提确认（已验证）：全部 `workflow-*` suite 的 executor 均以 `{{sut.dir}}`
为项目目录，`--extra-memory-dir` 在 SUT 解析后应用 overlay，通路对 §6.1
映射表中的所有 suite 有效。

**Overlay 必须无残留（runner 侧硬约束）**：`resolveSut` 返回的是持久
checkout（`local_dir` / `EVAL_SUT_DIR`），不是每次新克隆——overlay 若直接
覆盖 `.aws/memory/` 且不恢复，会泄漏进后续任何 run（包括下一次基线跑），
即使本文重排了 E/F 顺序也挡不住这条污染路径。因此 runner 契约为：
应用 overlay 前快照工作区 `.aws/memory/`（含"原本不存在"这一状态），
suite 跑完后恢复原状；恢复失败视为 run 级错误显式上报，不得静默吞掉。

### 8.3 回归判定（引用 p0-metrics.yaml，不拍临时阈值）

对每个 suite，逐指标按 `eval/contracts/p0-metrics.yaml` 的 gate mode 分级判定：

| gate mode | 判定规则 |
|---|---|
| `hard_gates` | 候选侧必须满足 suite 阈值；**且**任一指标不得较基线**劣化超出容差**（见下）。语义上这既覆盖"基线过、候选不过"，也覆盖"候选虽仍达标但明显低于基线"——二者都判回归。任一违反 → 回归 |
| `advisory` | 候选值劣于基线超出容差 → 记警告，不判回归 |
| `observe` | 仅记录 delta，进报告，不参与判定 |

噪声容差（LLM-judge / 采样波动）——劣化一律**相对基线**判定，不是只看阈值穿越：

- 比率类指标（`*_rate`）：容差 ε = 0.02（绝对值）。`候选 < 基线 - ε` 才算劣化。
  **即使候选仍高于 suite 阈值**，只要较基线跌破 ε 也算 hard_gate 回归（保守取向：
  宁可让候选带着 rework_note 回炉，也不把"看似达标、实则退步"的规则写进 memory）。
  实现见 `src/retro/nightly/phase_f.ts` 的 `isRegressionMetric`。
- 计数类硬门（`secret_leak_count`、`forbidden_write_executed_count`）：零容差，
  阈值本身就是 `== 0`。
- `workflow-full` 只有 observe 指标、无 hard_gates —— 对照结论只能是
  "无回归信号"（弱通过），报告中显式标注置信级别为 observe-only，**不得自动 apply**。

判定语义（父 spec §9.4）：通过 = **无害**（不劣于基线），不证明规则有效；
有效性由后续 benchmark 的 signal_count 趋势验证（§9 报告）。

### 8.4 结果落账：通过才真正 apply

验证先行（§7）之后，PHASE F 的结果处理变为：

- **通过**：仅当 candidate eval gate 通过且 suite 对照为 hard-gated
  `no_regression` 时，才把规则写进活 SUT——对该 suite 组内每条 proposal 执行
  `cd <sut> && aws retro apply --retro <rid> --proposal <pid>`（真实模式，
  无 `--stage-dir`），随后
  `cd <sut> && aws retro promote --retro <rid> --proposal <pid> --decision promoted --by phase-f --eval-run-id <run-id>`。
  需要给 `promote` 增加可选参数 `--eval-run-id`（写入 `RetroPromoteRecord.eval_run_id`，
  类型字段已存在）。last-record-wins 语义下这条记录保持 promoted 并补上
  eval_run_id——这就是"跨仓库回填"：run-id 产生于 skills 仓库
  `eval/out/runs/<run-id>/`，落账于 SUT 仓库 `qa/retro/<rid>/promotions.json`。
- **回归**：活 SUT 从未被写入，**无需回滚 memory 文件**。对组内每条
  proposal 记 `aws retro promote --decision needs_rework --by phase-f
  --note "<suite> regressed: <指标列表与 delta>"`。组内粒度说明：同 suite
  批量验证无法归因到单条 proposal，回归时**整组拒绝**——宁可错杀
  （下一轮 PHASE C 会带着 rework_note 重新起草），不可留下未经验证的规则。
- **observe-only 弱通过**：不 apply。对组内 proposal 记 `needs_rework`
  并说明该 suite 无 hard gate，需要人工介入或改用 hard-gated suite。
- **eval 自身失败**（run 异常退出/超时、`sample_execution_error`、
  `runner_error:*`、scorer 异常导致的 gate fail）：不 apply、不落业务回归决策，
  报告标 `eval_error`，下次 resume 重试该 suite（stage 目录重新渲染即可）。

`aws retro rollback`（标 `deprecated:`，已实现）在新顺序下不再出现于
nightly 主路径，保留为**事后逃生通道**：规则通过无害验证入库后，若后续
benchmark 的 signal_count 趋势（§9）表明其实际有害，由人手动 rollback。

---

## 9. Nightly 报告（§12 第 8 项详细设计）

每轮 `resume` 结束（或 `collect` 提前收尾）时生成两份产物：

- `qa/retro/<rid>/nightly-report.json` —— 机器可读，跨 run 趋势的数据源
- `qa/retro/<rid>/nightly-report.md` —— 人读

`nightly-report.json` 结构：

```json
{
  "retro_id": "retro-20260708-2130",
  "generated_at": "...",
  "phase_reached": "F",
  "window": { "change_count": 3, "sources": {"archive": 1, "unarchived": 2} },
  "signal_count": 6,
  "evidence_incomplete": ["RET-x"],
  "proposals": { "generated": 4, "validation_rejected": 1, "auto_needs_rework": 1 },
  "decisions": { "promoted": 2, "rejected": 0, "needs_rework": 1, "pending": 0 },
  "apply": { "applied": ["RETRO-001", "RETRO-003"], "pr_only": [] },
  "eval": [
    { "suite": "workflow-api-codegen", "baseline": "main", "eval_run_id": "...",
      "verdict": "no_regression", "deltas": { "test_executable_rate": 0.0 } }
  ],
  "rollbacks": [],
  "alerts": []
}
```

`report` 子命令（或 resume 末尾自动执行）汇总最近 `--last` 个 retro run，产出三类内容：

1. **signal_count 趋势**：优先从各 `qa/retro/retro-*/nightly-report.json`
   取 `signal_count`，无报告时才从 `context.json` 重算；无 context 的占位 run
   不进入趋势（按 retro_id 中的时间分量排序）。这是闭环健康度的核心指标
   （父 spec §10）：随 memory 规则积累应下降。连续 3 轮不降 → 告警
   `signal_count_flat`。
2. **决策统计**：汇总各 run 的 promotions.json，按 decision 分布 + phase-f
   自动决策占比。promoted 数持续为 0 → 告警 `pipeline_starved`（提案质量或
   降噪阈值可能有问题）。
3. **连续 needs_rework 告警**：同源提案识别规则——`target` 相同且
   `problem` 前 80 字符归一化（去空白、小写）后相同，即视为同源
   （不引入语义嵌入，保持可测试的确定性规则）。同源链长度 ≥ `--rework-alert`
   → 告警 `stuck_proposal`，附各轮 rework_note，提示人介入而非继续循环。

告警只进报告与 stderr，不阻塞流程（driver 的失败语义只由 §10 的退出码定义）。

---

## 10. 退出码与失败恢复

| 码 | 含义 | 后续动作 |
|---|---|---|
| 0 | 该段正常完成 | collect 后等人审；resume 后本轮闭环完成 |
| 10 | 无事可做（无新 change / signal_count=0 / 无提案） | 无 |
| 30 | resume 时全部提案未决策 | 人审后重跑 resume |
| 40 | agent / eval / CLI 异常 | 修复后重跑同一段（各步幂等） |

崩溃恢复依赖既有幂等机制（父 spec §10），driver 不引入额外状态文件：

- PHASE A/B：`_state.json` 按 `(id, source)` 去重 + `stage` 分级
  （`aggregated` 可重放、`collected` 终态，见 §4）；retro 目录含
  promotions.json 后不可变（CLI 守卫已实现）。
- PHASE E：staging 渲染无副作用，重跑即重建 stage 目录。
- PHASE F：真实 apply 溯源键去重；promotions.json last-record-wins；
  eval 结果以 promotions 里是否有带 `eval_run_id` 的记录判断
  "该 suite 是否已验证"，resume 重跑只补缺失的。`--skip-eval` 不写活 SUT、
  不写 `eval_run_id`，因此不会污染后续正常验证的 baseline。

---

## 11. 落地清单

前置小修（不依赖 driver，先行合入）：

1. `aws retro apply`：校验范围收窄到被选中的提案（§7 现状缺陷）。
2. `aws retro promote`：增加可选 `--eval-run-id`（§8.4）。
3. `aws retro`：`change_sources[].path` 在快照存在时指向快照（§3）。
4. `aws retro apply --stage-dir <dir>`：staging 渲染模式，不写活 SUT（§7）。
5. `_state.json` 记录增加 `stage` 字段 + `aws retro complete --retro <rid>`
   子命令（§4 两段式记账；`aws retro` 聚合改为写 `stage: "aggregated"`）。
6. eval runner：`--extra-memory-dir` overlay 应用前快照工作区 `.aws/memory/`、
   run 结束后恢复（§8.2 无残留硬约束；已实现）。
7. `aws eval run --sut-dir <path>`：显式覆盖 registry/EVAL_SUT_DIR，使 PHASE F
   与 driver `--sut` 绑定（§2.1）。

driver 本体（`src/retro/nightly/driver.ts`，编译进 `aws`，无新依赖）：

7. `collect`：PHASE A 枚举/去重/status 判定/快照 + PHASE B 聚合 +
   PHASE C agent 调用与校验 + PHASE D 队列生成与降噪 + 成功后 `complete` 记账。
8. `resume`：PHASE E staging 渲染 + PHASE F 对照/判定/通过后真实 apply/落账 + 报告。
9. `report`：跨 run 汇总与三类告警。

测试策略：

- PHASE A/D/F 的判定逻辑抽成可单测的 TypeScript 纯函数模块（`src/retro/nightly/*.ts`），
  用 fixture retro 目录做单元测试（对照 `tests/unit/retro/` 现有风格）。
- agent 与 eval 调用在测试中以 stub 命令注入（`--agent`、内部 exec 均可替换），
  不在单测里真跑 LLM。
- 端到端冒烟：以 `eval/suites/_test.yaml` 与 fixture SUT 走通 collect→resume
  全链路（CI 可跑）。
