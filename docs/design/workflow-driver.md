# Workflow Driver：TS 编排器替代 LLM 主 agent

> 目标：把 `aws-workflow` / `aws-execute` 自主执行路径的编排循环从"主 agent 照 SKILL.md 执行"
> 迁移到确定性 TS driver；phase 工作仍由 agent 完成，通过 opencode server API 以子 session
> 形式运行，完整保留 openchamber 的聊天窗启动、侧边栏父子树、实时流式输出与 agent 权限模型。
> 交互式入口（`aws-intake`、case-design 澄清对话）保持 agent+skill 形态不变。

---

## 0. 背景与动机

### 0.1 编排决策早已确定性化，LLM 只剩"解释器"角色

`src/workflow/orchestration/engine.ts` 自述："No LLM. Pure function of workflow-schema.yaml + workflow-state.yaml"。
`aws status --next --json` 产出确定性 dispatch 列表，`aws gate check` 做确定性门禁裁决。
主 agent 在循环里做的事就是 `aws-workflow/SKILL.md` 里那段伪代码
（loop → status → dispatch → hash check → gate check → state apply）——纯机械执行。

### 0.2 对抗 LLM 漂移的成本已经失控

| 现状机制 | 存在的唯一理由 |
|---|---|
| `aws-workflow/SKILL.md` 3631 行 / 184KB，105 处 MUST NOT / HALT / never | 用文档体积对抗概率性执行 |
| 每轮 dispatch 后 sha256 对比 `workflow-state.yaml`（H0 check） | 事后检测 subagent / 主 agent 越界写状态 |
| healing 证据推导 | 从 active batch、analysis、proposal、apply events 与 decision 确定状态，不再双写 |
| `aws-execute` 把 runbook 全文 inline | "To reduce execution omission"（防遗漏） |
| max 50 iterations 保险丝 | 防 LLM 死循环 |

driver 接管后，这一整类防御机制降级为廉价断言或直接删除。

### 0.3 仓库内已有两个成功先例

- `aws retro nightly`：编译后的 TS driver 编排 PHASE A–F，只在需要创造性的 PHASE C
  通过 `--agent` 唤起 agent + skill，agent 退出后立即机器校验。
- `src/eval/executor.ts`：eval harness 以脚本身份 spawn agent 并按产物打分。

### 0.4 产品目标对齐

openchamber 的产品目标是 Manus 式"打字完成测试"。Manus 架构本身即
**对话 agent + 后台确定性执行器 + 结构化进度 UI**，而非一个大 LLM 亲自跑循环。
现有 two-stage 设计（intake 交互 → execute 自主）已经切好了这条边界。

---

## 1. 范围与非目标

覆盖：

1. **driver 本体**：`aws workflow run / resume` 命令组，移植编排循环。
2. **opencode 适配层**：经 server HTTP API 创建/驱动 phase 子 session（保留 UI 体验），
   以及无 opencode 环境的 headless CLI 适配器（benchmark / CI 用）。
3. **聊天窗启动与回notify**：`workflow_start` 自定义 tool；driver 经 `session.prompt`
   反向叫醒主会话（人审 STOP、最终总结）。
4. **skill / agent 配置侧改动**：`aws-workflow` 瘦身为 fallback、explore 常规化、
   phase prompt 契约固化进 driver。

非目标：

- 不改任何 phase skill 的内部契约（produces、gate、评审规则一概不动）。
- 不改 openchamber（现有 QA 面板、session 树、SSE 渲染零改动；"一键启动"按钮属后续可选项）。
- 不迁移 `aws-intake` / case-design 的交互对话（保持 agent 形态）。
- 不改 `workflow-schema.yaml` 的 phase/gate 语义（driver 是 schema 的另一个消费者）。

---

## 2. 目标架构

```text
用户打字（openchamber 聊天窗，主会话）
   │
   ▼
前台对话 agent（薄）── aws-intake 角色：理解意图、多轮澄清、case-design 对话
   │  用户确认后调用 workflow_start tool（tool ctx 自带 sessionID）
   ▼
TS driver（aws workflow run --change <id> --parent-session <sid> --server <url>）
   │  循环：aws status --next --json → dispatch → 产物校验 → state apply → gate check
   │  每个 agent phase：POST /session（parentID=主会话）→ POST /session/{id}/message(agent=…)
   ▼
phase agent sessions ──SSE /event──▶ openchamber 聊天区流式渲染 + 侧边栏嵌套树
   │  写产物文件（cases/plans/tests/results/report）
   ▼
workflow-state.yaml / events.jsonl / report ──▶ QA 面板（现有 /api/qa/* 链路，不动）

人审 STOP / 终态：driver 经 POST /session/{parent}/message 叫醒前台 agent，
用户在聊天窗决策 → 前台 agent 执行 aws decide → 再次运行 driver
```

角色与权限的重新分配：

| 角色 | 现状 | driver 模式 |
|---|---|---|
| 编排者（status/gate/state 写权） | 主 agent（LLM，靠 3631 行 prompt 自律） | driver 进程（可信代码，无需约束） |
| phase worker | `.opencode/agents/*.md` permission floor | **原样不动**，server 照常强制 |
| 前台对话 agent | 与编排者同一 agent，全权限 | 独立窄权限 agent（intake 所需 + workflow_start） |

---

## 3. 已验证前提与 M0 前置验证

以下事实已用 `/tmp/opencode-spike.mjs` 对本地无鉴权 opencode server
（`serve --port 4096`）实测通过，driver 设计以此为基础契约：

1. **父子树**：`POST /session` 接受 `parentID` + `title`；`GET /session/{id}/children` 返回子会话。
   openchamber 侧边栏纯按 `session.parentID` 组树（`useSessionGrouping.ts`），不区分创建者是
   task tool 还是外部 API 客户端。
2. **流式输出**：`POST /session/{id}/message` 阻塞至回合结束并返回完整 parts；期间 `/event` SSE
   持续推送 `message.part.updated` 增量（实测 6 个增量事件、文本逐步增长）——openchamber
   聊天区实时渲染吃的就是这条流。
3. **反向叫醒**：对主会话调 `POST /session/{id}/message` 能正常触发该会话 agent 发言，
   人审通知与最终总结可由 driver 推回聊天窗。
4. **权限 floor 对 API session 生效**：prompt 时指定 `agent: "aws-test-author"`，
   `.opencode/agents/aws-test-author.md` 的 `bash: {"*": deny}` 使 server **在工具集层面**
   不向该 agent 提供 bash（实测 agent 自述工具集仅 read/write/edit/glob/grep），
   与 task tool 路径同一套 enforcement。`GET /agent?directory=…` 可列出全部
   `aws-*` agent（均 `mode: all`，可直接指定）。
5. **API 细节**：所有请求须带 `?directory=<项目绝对路径>`（session 按目录归属项目）；
   prompt 体支持 `agent` / `model` / `tools: {name: bool}` 覆盖 / `system` / `noReply`；
   另有 `POST /session/{id}/prompt_async` 供并行分支使用。

上述 spike **没有**验证 managed OpenChamber 的 Basic Auth、busy 父会话、custom tool ctx、
无显式 model 的新 session、`prompt_async` 完成检测或 detached spawn。它们不得被当成
已验证事实。进入 M1 前必须完成 M0 spike：

1. 在 OpenChamber 实际托管的 opencode 实例上，验证带 Basic Auth 的
   create session / sync prompt / prompt_async / status / abort。
2. 打印并固化 custom tool ctx 的真实字段，至少确认 `sessionID`、`directory`；
   server URL 不假定来自 ctx，按 §7 的显式解析契约取得。
3. 父 session 处于 busy 时验证 409；确认 idle 等待 + 重试后通知只送达一次。
4. detached spawn 后确认 driver 继承鉴权环境、使用 SUT cwd，且 tool 回合结束后进程继续运行。
5. `prompt_async` 返回 204；`GET /session/status` 中 `busy|retry` 均视为未完成，
   session 缺失于 map 才视为 idle。

M0 任一项失败即阻塞 M1，不允许退化为“先实现再观察”。

---

## 4. Driver 形态：CLI 命令组与退出码

新增 `aws workflow` 命令组（实现在 `src/workflow/driver/`，注册进 `src/cli.ts`）：

```text
aws workflow run --change <id> --scope <execute|full>
    [--server <url> --parent-session <sid> --directory <sut-path>]
    [--adapter <opencode|headless>] [--agent-cmd <cmd>]      # headless 用
    [--params <json>]                                         # 运行时参数覆盖
    从头或从当前 workflow-state 断点继续跑编排循环，直到 terminal / 人审 STOP。

aws workflow run --change <id>
    人审决策（aws decide）落盘后继续；run 本身幂等：
    resume ≡ run（循环入口本就以 aws status 为准），单独立名仅为语义清晰。

aws workflow status --change <id>
    透传 aws status --next --json 并附加 driver 侧运行元数据（driver.json，见 §7）。
```

退出码（对齐 `retro-nightly.mjs` 约定）：

| 码 | 含义 | 后续动作 |
|---|---|---|
| 0 | terminal.kind = completed | 前台 agent 总结 |
| 20 | terminal.kind = stopped（gate stop/reject） | 前台 agent 呈现原因 |
| 30 | 人审 STOP（`needs_human_review` / bootstrap 契约冲突） | 用户决策 → `aws decide`（§8）→ 再次 run |
| 40 | phase 重试耗尽 / opencode API 异常 / 产物校验失败 | 修复后 resume（循环幂等） |

driver 无守护进程形态：一次 `run` 进程存活到 terminal 或 STOP 退出。
业务断点只由 `workflow-state.yaml` + 机器产物 + `aws status` 决定；`driver.json/lock`
仅记录进程生命周期与待送通知，不得成为 phase 路由真相源。

### 4.1 启动前置、运行时参数与 run context

`--scope execute` 要求已有 intake handoff：change 目录、`workflow-state.yaml`、
通过的 case review、cases、advisory（若存在）与 test-infra contract 均满足
`aws-execute` Preflight。`--scope full` 在进入 schema router 前运行 test-infra bootstrap
和 skill-registry-check；这两者是显式 internal executor，不是 `aws run` phase。

沿用 `aws-workflow` 的参数表（run_mode / test_types / max_*_attempts / force_continue /
run_tests / max_healing_attempts / e2e_framework）。新增 CLI-owned 原子配置命令：

```bash
aws state configure --change <id> --params-json '<json>' \
  --orchestrator <aws-execute|aws-workflow>
```

它合并并校验 `workflow-state.yaml.params`、保留既有 intake phase state，再调用现有
`stampRunContext`。execute scope 使用 `aws-execute`，full scope 使用 `aws-workflow`；
因此 `active_scope` 继续由现有映射可靠派生。driver 身份与版本写入 `driver.json` /
driver events，不新增 `aws-workflow-driver` orchestrator 值。

`force_continue` 必须加入 schema params。它只允许在 review 的**基础 decision 已为 pass**
时绕过 `human_review_required == true` 或 `risk_level in [high, critical]`；显式
`decision == needs_human_review` 仍要求人审。所有 codegen precondition、reject、blocker、
fixer-safety 与执行安全门禁都不可绕过。对应 gate DSL 必须直接读取
`params.force_continue`，使 `aws status` 与 driver 的结论一致，driver 不得在外层假装通过
一个仍为 `awaiting_gate` 的 phase。

---

## 5. 编排循环（SKILL.md runbook → 确定性 TS）

```text
configure + preflight:
  aws state configure(...logical orchestrator...)
  full only: run test-infra-bootstrap internal executor
  run skill-registry-check internal executor
  apply both CLI-owned state reducers before entering router

loop (max 50):
  dispatch = aws status --change <id> --next --json
  parse JSON stdout even when child exit code is 10/20
  if terminal.completed: notifyParentOnce(); exit(0)
  if terminal.stopped:   notifyParentOnce(); exit(20)

  for entry in dispatch.next:
    H0 = sha256(workflow-state.yaml)
    execute(entry.executor):
      internal:*       -> run the named deterministic internal executor
      cli:aws-run      -> aws run --change <id>
      agent:opencode   -> create child session + promptSync (M1)
    verify phase-owned outputs are fresh and contract-valid
    assert sha256(workflow-state.yaml) == H0
    aws state apply --change <id> --phase <phase>
    if entry.gate != null:
      gate = aws gate check --phase <phase> --change <id> --json
      routeGateVerdict(entry, gate)                 # §5.3 / §5.4
```

执行顺序是硬约束：**产物校验 → H0 断言 → state reducer → gate check**。registry gate
读取 `workflow-state.yaml`，若先 gate 后 apply 会必然失败。`aws gate check` 当前只计算
verdict 并追加 event，不替代 phase state reducer。

### 5.1 dispatch 解析

内部 `StatusReport.next` 是 phase id 数组，但当前 `aws status --next --json` 已通过
`resolveNextDispatch` 返回 `{phase, kind, skill, agent}` 对象；不再做“对象化”迁移。
扩展现有 `PhaseDispatchEntry`：

```ts
type PhaseExecutor =
  | 'internal:test-infra-bootstrap'
  | 'internal:skill-registry-check'
  | 'cli:aws-run'
  | 'agent:opencode';

interface PhaseDispatchEntry {
  phase: string;
  kind: 'internal' | 'cli' | 'agent';
  executor: PhaseExecutor;
  skill: string | null;
  agent: string | null;
  gate: string | null;
}
```

`executor` 不能仅由 `skill === null` 推导：`skill-registry-check` 与
`execution/healing-rerun` 都是 `skill: null`，但只有后两者执行 `aws run`。
resolver 必须对所有 schema phase fail-closed；未知 internal/CLI phase 直接 exit(40)。

并行：M1 一律串行。M2 起，同一迭代内互相独立的分支（`api-plan`/`e2e-plan`、
`api-codegen`/`e2e-codegen`）可用 `prompt_async` 并发派发，等**全部**分支到达
idle/failed 后再统一做产物校验、state apply 与 gate check（完成检测契约见 §6.1）。
其余一律串行。

### 5.2 状态写入：统一 reducer，driver 不拼 YAML patch

扩展现有 `aws state apply` 为 phase reducer registry，而不是让 driver 解析 subagent
自由文本。每个 reducer 从该 phase 的机器产物推导允许字段，原子更新 state，并记录
`skill_loaded`。未注册 phase fail-closed。

| 时机 | CLI-owned reducer |
|---|---|
| 参数 + run context | `aws state configure`（§4.1） |
| ordinary agent phase | driver 直接调用 core reducer，并以内置 SKILL.md 路径从 produces 推导 status/outputs |
| review phase | 同上，从 review JSON 推导 `pass|needs_fix|needs_human_review|reject`、gate file 与 skill fields |
| review fixer | 同上，从 apply-summary 追加原 review phase 的 `fix_attempts`；不得把 reviewer status 改为 pass |
| CLI / CLI-backed phase | 保留 execution、healing-rerun、inspect、healing-reinspect、report reducers |
| healing 状态 | 机械状态由证据推导；`aws state heal --to` 只记录 resolved/not_needed/skipped/exhausted/failed 判断 |
| 人工裁决（仅前台 agent 在用户决策后执行） | `aws decide --change <id> --at <p> --action <a> --reason "…"` |
| bootstrap 人工裁决 | `aws decide --change <id> --at bootstrap --action skip_branch --reason "…"`，由 driver 从 `human_decision` 事件消费 |

所有 reducer 都要有 fixture-based 单测，验证只写 allowlist 字段、旧 state 保留、重复调用幂等。
Phase 产物校验不能只检查“文件存在”：必须比较 dispatch 前后的 hash/mtime 或 batch id，
避免旧产物让失败的 retry 假成功；目录/YAML/Markdown 使用各自 validator。

### 5.3 Gate verdict 路由与 review fix loop

driver 按 JSON `verdict` 路由，不直接传播 `aws gate check` 的进程退出码：

| verdict | driver 动作 |
|---|---|
| `pass` | phase 完成，回主循环 |
| `needs_fix` | 读取 `recommended_phase`，执行 `fixer → state apply fixer → 原 reviewer → state apply reviewer → gate check`；受 `max_*_fix_attempts` 限制 |
| `needs_human_review` | 写 paused、通知父会话、exit(30) |
| `reject` / `stop` | terminal stopped，exit(20) |
| `enter` / `skip` | 仅 healing-entry-gate 合法，进入 §5.4 |
| `continue` / `exit` | 仅 healing-loop-gate 合法，进入下一 attempt / 收敛 |
| 其他 | fail-closed，exit(40) |

review fixer 从不修改 review JSON，也不释放 gate。每次 fixer 后必须重新 dispatch 原 reviewer，
产生**新的** review JSON，再次 apply + gate check。达到上限仍非 pass → stopped；不能期待
普通 `aws status` 自动调度 repair phase，因为 review 此时是 `awaiting_gate`，且 fixer
可能与 reviewer 共享 produces 路径。

### 5.4 HealingSubroutine（不得压缩）

1. primary inspect 后执行 `aws state apply --phase inspect`，再检查 healing-entry-gate。
2. `skip`：按证据执行 `aws state heal --to not_needed|skipped`，然后允许 report。
3. `enter`：首次进入一个 healing episode 时 pin `healing/entry-baseline.json`，并严格记录
   `healing_entry_baseline_pinned`（artifact SHA、entry batch、episode id）。同一 episode
   的 rerun batch/attempt 复用该 baseline；终态 healing judgment 或 stop decision 后，
   下一次进入才刷新。随后 dispatch fix-proposal，并用 dispatch timestamp 作为
   driver 直接调用 core reducer，并传入 dispatch freshness watermark。
   Proposal 必须同时绑定最新 `source_batch_id` 与当前
   `inspect/failure-analysis.json` 的 `source_analysis_sha256`。
4. 对每个 eligible target dispatch fixer；agent 不得伪造 apply-summary。随后执行：

   ```bash
   aws heal record-apply --change <id> --target <api|e2e> --proposal <ids>
   ```

5. 全部 target 记录完成后由 core 生成 `healing/fixer-safety-check.json`，
   其中 `checked_tests_tree_sha256` 固定检查时的测试树。只有该值仍等于当前测试树、
   attempt/batch 绑定仍有效，且 safety pass 或对应 SHA 的 `accept_risk` 有效时，才可推导
   `applied` 并单独 pin applied rerun test tree；暂停期间修改测试会使旧 safety/decision 失效。
6. pass 后 `aws run` → `aws state apply --phase healing-rerun` →
   dispatch aws-inspect → driver 以内部 SKILL.md 路径调用 core reducer。
7. 检查 healing-loop-gate：`exit` → `aws state heal --to resolved`；
   `continue` → 基于最新 batch 写新 proposal 并回到步骤 3；
   达上限 → `exhausted`；异常 → `failed`。任何 attempt 都不得复用旧 proposal/batch。

恢复时若证据已推导为 `applied`，driver 从 applied-tree pin/validation 继续步骤 6–7。
即使 `attempts_used == max_healing_attempts`，也不得在 rerun 和 re-inspect 前提前记录
`exhausted`，不得重写 proposal、fixer summary、safety artifact，且必须保留已有
SHA-bound `accept_risk` decision。只有 re-inspect 后仍失败且预算耗尽，才记录
`exhausted`。

### 5.5 防御机制的降级

- **H0 sha256 check**：保留为廉价断言（permission floor 已在工具集层面挡住写入，
  断言只为捕捉 floor 配置回归），失败即 exit(40) 并指认 phase。
- **max 50 iterations**：保留（防 schema 环路 bug），触发即 exit(40)。
- **subagent retry ≤ 2**：保留，driver 实现。

---

## 6. OpenCode 适配层与 headless fallback

`src/workflow/driver/adapter.ts` 定义最小接口，两个实现：

```ts
interface PhaseAgentAdapter {
  createPhaseSession(opts: { title: string; parentSessionID?: string }): Promise<{ id: string }>;
  promptSync(sessionID: string, opts: PhasePrompt): Promise<PromptResult>;
  promptAsync(sessionID: string, opts: PhasePrompt): Promise<void>; // 204, no body
  getStatus(sessionID: string): Promise<'idle' | 'busy' | 'retry'>;
  abort(sessionID: string): Promise<void>;
  notifyParentOnce(input: ParentNotification): Promise<void>;
}
```

### 6.1 opencode adapter（默认，保 UI 体验）

- 纯 `fetch`，端点限定为 session create/get/prompt/prompt_async/status/abort；以 M0
  contract test 锁定当前 OpenCode 版本。所有请求带 `?directory=<SUT 绝对路径>`。
- connection config 必含 `{baseUrl, directory, authHeaders}`。managed OpenChamber 的
  Basic Auth 凭据只经环境变量传递，不放 CLI 参数或 `driver.json`；adapter 对每个请求
  携带与 OpenChamber 相同的 Authorization header。无鉴权只允许显式配置的 loopback server。
- 子 session：`POST /session {parentID, title}`；标题规范
  `"Phase <n> <phase-id>[ attempt <k>]"`（driver 显式命名，不靠 LLM 起名）。
- 派发：`POST /session/{id}/message`，体含
  `{agent: <schema agent>, parts: [{type:"text", text: <phase prompt>}]}`。
  phase prompt 契约沿用 Scheme E dispatch prompt 原文：
  *"Call skill(name='<skill>'). Produce only the outputs for phase <phase> as described
  in the skill. Do NOT run aws gate/status. Do NOT modify workflow-state.yaml."*
- `tools` 只能进一步关闭工具，禁止由 driver 用 `tools: true` 扩大 agent permission floor。
- M1 全串行使用 `promptSync`。M2 并行才使用 `prompt_async` + `GET /session/status`：
  `busy|retry` 都继续等待，map 中缺失才是 idle；async 端点的 204 不按 JSON 解析。
- 每个 phase 有连接 timeout、总 timeout 和 abort：超时先 `POST /session/{id}/abort`，
  再按 retry policy 新建 attempt session；耗尽 exit(40)。permission/question pending
  仍算 session 未完成，由 OpenChamber 在对应子 session 显示交互请求。
- 模型解析顺序：显式 driver 参数 → parent session 记录的 model → server 配置默认值；
  三者皆无则 preflight 失败。最终 `{providerID, modelID, variant}` 写入 `driver.json`，
  每个子 session 使用同一解析结果，避免后台 phase 随 UI 当前选择漂移。
- `notifyParentOnce` 先轮询 parent idle；409 使用有上限指数退避，不 abort 用户正在进行的
  对话。通知使用稳定 message id（`driver:<run-id>:<notification-kind>`）保证重试幂等；
  失败则写 `notify_pending`，由下一次 status/resume 补送。
- OpenChamber 自己订阅 `/event` 并渲染增量；driver 不转发 SSE。driver 只在 async
  completion 或调试时消费 status/events。

### 6.2 headless adapter（benchmark / CI / 无 opencode 环境）

- 沿用 `aws retro nightly` 的 agent command 抽象：每个 phase spawn 一次
  `cursor-agent --print …`（或任意兼容 CLI），prompt 同一契约。
- 无 session 树与流式 UI；stdout 落 driver 日志。产物校验、gate、state 路径与
  opencode adapter 完全一致。
- 以 `src/retro/nightly/driver.ts` / `src/retro/nightly/exec.ts` 的 agent command
  注入为参考；现有仓库没有 `run-workflow-loop-cursor.sh`，不得把不存在的脚本列为迁移目标。
- 后续实际 benchmark 入口先盘点并记录路径，再迁移为
  `aws workflow run --adapter headless`，消除另写编排 prompt 的漂移源。

---

## 7. 聊天窗启动：`workflow_start` 自定义 tool

package 新增 `.opencode/tools/workflow_start.ts`，并把 `src/workflow/core/agents_assets.ts` 泛化为
runtime OpenCode assets 同步器；`aws init` / `aws skill ... --sync-agents` 同步 agent
和 tool 到 SUT。不能只在 spec 仓库新增文件而假定 SUT 会自动发现。

- 入参：`{change_id, scope, params?}`。ctx 的 `sessionID` / `directory` 字段名由 M0
  spike 固化，未验证前不编码猜测。
- server URL 解析顺序：`AWS_OPENCODE_SERVER_URL` → 从当前 opencode serve 的
  `process.argv` 解析显式 hostname/port；不使用隐式 4096 默认值，无法解析即 fail-closed。
  Basic Auth 从当前 tool 进程的 OpenCode 鉴权环境继承；M0 验证变量名后写入安装契约。
- tool 用 `fs.open(..., 'wx')` 原子获取 `qa/changes/<id>/driver.lock` 后 detached spawn
  `aws workflow run --change <change_id> --scope <scope> --server <local opencode url> --parent-session <ctx.sessionID> --directory <ctx.directory>`，
  并设置 `{cwd: ctx.directory, detached: true, stdio: <driver.log>, env: inherited}` 后
  `unref()`。spawn 失败必须释放 lock。
- 写入 `qa/changes/<id>/driver.json` 后立即返回
  "已启动，phase 进度见左侧子会话与 QA 面板"。
- `driver.json` 最小 schema：

  ```json
  {
    "run_id": "<uuid>",
    "status": "running|paused|completed|failed",
    "pid": 123,
    "started_at": "...",
    "updated_at": "...",
    "parent_session_id": "...",
    "directory": "...",
    "current_phase": "...",
    "paused_on": null,
    "notify_pending": null
  }
  ```

- 幂等：原子 lock 成功者才可启动；`running` + 已验证同一 command/start token 的活 pid
  → 拒绝重复；`paused|failed` 且无活进程 → 允许 resume；`completed` 默认拒绝。
  driver 在正常 exit(0/20/30/40) 前原子 rename 更新 JSON 并释放 lock。崩溃遗留 lock
  只有在 pid 不存活或 start token 不匹配时才能回收，不能只靠 PID 数字防复用。

前台 agent 的交互脚本（写入前台 agent 的窄权限配置 + intake skill 尾部）：

1. intake 完成、用户确认 → 调 `workflow_start`。
2. 收到 driver 的人审通知（driver `notifyParentOnce` 触发本会话）→ 向用户呈现决策项 →
   用户答复 → 按 §8 执行 `aws decide` →
   调 `workflow_start`（等价 resume，幂等入口）。
3. 收到终态通知 → 读 `report/summary.md` 向用户总结。

openchamber 零改动即可用；后续可选增强：QAChangeToolbar 加"Run workflow"按钮
直接调本地 API 启动 driver（非本 spec 范围）。

---

## 8. 人审 STOP、通知与恢复

- driver 遇 `needs_human_review`：
  1. 写 `driver.json.status=paused`、`paused_on`、gate evidence hash 与原因；
  2. `notifyParentOnce("<phase> 需要人工决策：<原因摘要>。请回复决策。")`；
  3. exit(30)。
- 用户在聊天窗答复 → 前台 agent 执行 `aws decide`（唯一合法的人审裁决入口，
  与现状一致）→ 重新调 `workflow_start` → driver 以 `aws status` 为准从断点继续。
- bootstrap contract conflict 使用 `bootstrap` checkpoint。用户明确
  选择 skip 后，前台 agent 调 `aws decide --at bootstrap --action skip_branch ...`；选择修复则不写决定，
  用户修改文件后 resume 重新验证 contract。
- gate decision 必须绑定当前 review SHA；再次运行时 SHA 漂移则 decision 失效，重新暂停。
- 父会话通知失败不改变 paused/terminal 事实；保留 `notify_pending`，`aws workflow status`
  与后续 resume 都尝试补送。前台 agent 不应因通知文本自动批准或重复启动。
- `force_continue` 完全由 §4.1 schema/gate 规则实现，不在本节做第二套外层判断。

---

## 9. explore 阶段常规化

现有 `aws-doc-author` 已允许 `aws risk *` 和 `explore/**`，schema 也已把 explore 映射到它；
无需新增 `aws-explorer`、扩 `ALLOWED_AGENTS` 或增加一套资产。

M2 在 M0 证明 direct API session 确实获得该 Bash allowlist 后：

- 更新 `aws-doc-author.md`，删除“explore 永远 inline”文字，但保留 bash 仅 `aws risk *`、
  edit 仅既有 QA allowlist、`workflow-state.yaml: deny`。
- 更新 `.opencode/agents/README.md` 与 `aws-workflow` fallback 文档：driver 模式下 dispatch，
  fallback task 模式继续 inline（因为 task subagent 仍可能无 Bash tool）。
- schema 不改 agent 字段；两种执行模式按 driver/fallback 能力分支。

---

## 10. 进度可观测性

- **QA 面板**（现有 `/api/qa/workflow-state`、`/api/qa/changes` 链路）：不改。
  driver 每步同步写状态，面板不再出现"agent 忘 apply delta 导致卡旧状态"。
- **编排事件**：`events.ts` 当前是封闭 union，不存在隐式扩展位。显式增加
  `source: driver` 与 `driver_started` / `phase_dispatched` / `phase_attempt_finished` /
  `driver_paused` / `driver_resumed` / `driver_finished`；`gate_verdict` 继续只由 gate CLI 写，
  `phase_transition` 继续只由 status/state reducer 写，禁止重复事件。这给 openchamber 后续做
  Manus 式任务进度条提供确定性数据源——LLM 编排下无法保证按契约上报，driver 可以。
- **子 session 命名**：见 §6.1，保证侧边栏树可读、按 phase 可检索。

---

## 11. Skill 与配置侧改动清单

| 对象 | 改动 |
|---|---|
| `skills/aws-workflow/SKILL.md` | 保留为**无 driver 环境的 fallback 入口**；M3 才瘦身。fallback task 模式继续保留 explore inline-only；头部声明优先使用 `aws workflow run` |
| `skills/aws-execute/SKILL.md` | M1 期间作为 driver 行为对照基线，验收通过后 M3 瘦身 |
| `skills/aws-intake/SKILL.md` | 尾部新增"确认后调用 `workflow_start`"的衔接段 |
| `.opencode/agents/*.md`（5 个既有） | permission floor 保持；M2 仅更新 `aws-doc-author` 的 explore 文字约束 |
| `.opencode/tools/workflow_start.ts` | 新增并纳入 init/sync assets（§7） |
| `docs/design/workflow-schema.yaml` | 增加 `force_continue` param 并把允许绕过条件写进 review gate DSL；explore agent 不改 |
| `src/commands/state.ts` / `src/workflow/core/workflow_state.ts` | 增加 configure、全 phase reducer registry、bootstrap override |
| `src/workflow/core/events.ts` | 增加显式 driver event source/types，保持与现有 gate/status 事件职责互斥 |
| 各 phase skill | **零改动** |

---

## 12. 迁移路线与验证

分四步，每步可独立回滚（fallback 入口始终存在）：

- **M0 — API / tool / process contract spike**：完成 §3 的 managed Auth、ctx、busy、
  async status、abort 与 detached spawn 验证，产出可执行 contract tests。
- **M1 — execute scope（串行）**：先落 state reducers 和 dispatch executor，再覆盖
  `aws-execute` 全部 preflight、review/fix/re-review、codegen hard gate、execution、
  inspect、完整 HealingSubroutine 与 report。该范围明确声明 "no interactive questions"。
- **M2 — full scope**：并入 explore（§9）+ case-design 派发 + test-infra bootstrap
  （bootstrap 的 STOP-and-ask 走 §8 人审通道）。
- **M3 — 入口收敛**：定义前台窄权限 agent；intake 尾部接 `workflow_start`；盘点后迁移
  真实 benchmark 入口到 headless adapter；最后瘦身 `aws-workflow/aws-execute`。

验证（复用现有 eval harness，不新建基建）：

1. reducer 单测：每个 phase fixture 验证 allowlist patch、skill_loaded、freshness、幂等；
   review fixer 验证只能追加 attempts，不能自行 pass。
2. router 单测：覆盖所有 verdict、`recommended_phase` fixer→reviewer 循环、attempt 上限、
   internal vs aws-run executor、status/gate 子进程非零退出码 JSON 解析。
3. HealingSubroutine 集成测：覆盖 `not_needed`、单 attempt resolved、多 attempt continue、
   record-apply、fixer-safety 人审、exhausted 与 stale batch 拒绝。
4. adapter contract tests：managed Auth、sync/async、retry status、timeout abort、parent 409
   幂等补送、atomic lock/stale lock 回收；不真跑 phase LLM。
5. 端到端冒烟：headless adapter + fixture SUT 走通 run → 人审 STOP → resume → completed。
6. 对照评估：现有 `workflow-*` eval suite，driver 版 vs 主 agent 编排版各跑同一 dataset，
   对比 pass rate、token 消耗（编排侧应显著下降）、状态一致性错误
   （HEAL-STATE-INCONSISTENT / 卡状态类应归零）。
7. UI 验收：openchamber 里跑一次 M1 全程，核对侧边栏树、子 session 流式、
   QA 面板 phase 刷新、人审聊天往返、终态总结五项体验点。

---

## 13. 落地清单

M0 / 状态机前置：

1. 完成 §3 M0 spike 与 contract tests，固化 Auth env、tool ctx 和 URL 解析。
2. 扩展 `PhaseDispatchEntry`：补 `executor` / `gate`；已有对象化不重做。
3. schema 增加 `force_continue`，更新 review gate DSL 与 gate matrix tests。
4. 实现 `aws state configure`、全 phase `state apply` reducer registry、
   `aws decide --at bootstrap --action skip_branch`。
5. 扩展 `events.ts` 的 driver event union，明确去重边界。

driver 本体（`src/workflow/driver/`）：

6. `adapter.ts` + `opencode_adapter.ts` + `headless_adapter.ts`（§6）。
7. `gate_router.ts` + `review_fix_loop.ts` + `healing_subroutine.ts`。
8. `loop.ts`（§5，纯函数核心）+ `phase_prompt.ts`（Scheme E prompt 契约常量）。
9. `src/commands/workflow.ts` 注册 `aws workflow run/resume/status`（§4）。
10. `driver.json` 原子读写、lock 与幂等通知（§7/§8）。

配置与 skill：

11. `.opencode/tools/workflow_start.ts` + runtime assets 安装/同步。
12. M2 更新 `aws-doc-author` / agents README 的 explore 模式说明。
13. M3 定义前台 intake agent permission matrix，并修订三个 orchestrator skills。
14. 盘点真实 benchmark 入口后逐个切 `--adapter headless`，不存在的脚本不列迁移项。

---

## 14. 非阻塞设计选择

1. **`prompt_async` 并行失败归因**：M1 强制串行。M2 默认等待所有已派发分支到
   idle/failed，再统一校验；不因一支失败立即 abort 另一支，除非安全门禁要求。
2. **SDK 依赖**：M1 用窄 fetch adapter + contract tests；若 OpenCode 端点发生一次
   破坏性漂移，再引入并锁定 `@opencode-ai/sdk`。不提前增加依赖。
3. **healing session 复用**：每 phase 独立 session，fix-proposal/fixer/reinspect
   只通过文件产物传递上下文，保持权限和重试边界一致。
4. **前台窄权限 agent**：M3 前必须定义，至少允许 intake 产物、`workflow_start`、
   review 与 bootstrap decision；禁止测试代码和 workflow-state 任意编辑。
