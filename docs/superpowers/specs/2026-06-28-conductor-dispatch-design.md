# Conductor Dispatch 架构设计 (Spec)

- 日期: 2026-06-28
- 仓库: `Qingquanlv/assurance-workflow-skills`
- 状态: Draft v5(纳入四轮评审:校验/事件参数安全、quarantine manifest、完整 ready 公式、event 最小 payload、结构化 argv-only、默认 local + permission_mode)
- 范围: 完整架构

## 1. 背景与问题

当前 AWS QA workflow 在 OpenCode 中以 **primary agent inline 执行**:`aws-workflow` 技能顺序加载每个 phase skill,全部跑在同一上下文里。这带来两个真实问题:

1. **上下文天花板**:一次 16-phase 的真实 workflow(`20260626-role-mgmt`)在第 7 个 phase 就把上下文打到 108%,剩余 phase(需再读 ~120KB skill + 生成 ~12 个测试文件)无法在同一上下文继续。
2. **subagent 不能继承 skill**:OpenCode 的 task/subagent 无法可靠解析项目 skill(`OPENCODE-SKILL-RESOLUTION-001`),因此现状禁止 subagent 加载 skill,只允许 inline 或 document-driven subagent。

本设计把 `aws-workflow` 既有的 "document-driven subagent" 政策**工程化**,解决上下文天花板,同时严守"agent 不碰真相"的边界。

### 非目标

- 不实现 `omoRuntime`,不写 `omo run`。
- 不让 subagent 自动继承 SKILL.md,不把 SKILL 全文塞进 prompt。
- 不让 agent 修改 `workflow-state.yaml` / 跑 `aws gate check` / 判最终 PASS-FAIL。
- 不强依赖 OpenCode SDK 或 OMO。
- 不破坏现有 `aws run / report inspect / gate check / status`。

## 2. 核心原则

```
Skill belongs to Conductor.   # skill 由 Conductor 读取/编译,不进 agent
Task belongs to Agent.        # agent 只执行一份 task-brief
Truth belongs to Gate.        # 真相由确定性 gate/engine 裁决
UI observes events only.      # UI 只读 events/graph,不参与裁决
```

## 3. 总链路

```
SKILL.md
  -> Conductor reads / compiles (抽取可移植规则)
  -> task-brief.json
  -> opencode run 启动自定义 AWS agent (全新上下文)
  -> task-result.json
  -> Conductor validates (result_validator + git-diff + gate)
  -> events.ndjson / execution-graph.json
  -> OpenChamber 渲染主任务 + agent 树
```

## 4. 关键洞察:为什么"不停"成立

- 能一直跑的不是任何 agent 上下文,而是一个**无 LLM 上下文的 Node 进程**(`aws conductor run`)。
- 每个 agent phase 都是一个**新 spawn 的 `opencode run` 子进程 = 全新上下文**,读几 KB 的 brief、干一个 phase、写 task-result、进程退出即销毁,**永不累积**。
- conductor 循环本身只持有确定性状态(events / graph),所以可无限跑。
- **上下文是 Conductor 的结构性职责**(切分成 per-phase brief + fact-baseline),不在 agent 内解决,也不用 OMO 的上下文功能。

## 5. 静态图与动态图的分工(不新建静态图)

仓库已有静态 Phase DAG:`workflow-schema.yaml` + `src/orchestration/engine.ts`,它已表达:

- 依赖: `PhaseDef.requires` + `requires_mode`
- 并行前沿: `computeStatus().next`(同时 ready 的 phase 列表)
- 等待: `blocked` / `awaiting_gate`
- 条件裁剪(fuzz/perf): `when` 谓词 → `pruned`

因此 **Conductor 不自带 DAG**,而是调用现有引擎:

- **静态图(workflow-schema.yaml)** 回答"能不能跑 / 依赖 / 能否并行 / 等哪个门"。
- **动态图(execution-graph.json + events)** 回答"在不在跑 / 跑没跑完"(`RUNNING` 等运行态)。

引擎是无状态纯函数,**不表达 in-flight**。"已派发未完成"的去重由 Conductor 用 `events.ndjson`(`agent_dispatch_started` → 在 completed/failed 前不再派发)维护。

**约束**:`phase_mapping` 的 phase id 必须与 `workflow-schema.yaml` 的 phase id 完全一致。

### 5.1 状态模型(P0-1:谁写什么,computeStatus 读什么)

| 载体 | 内容 | 写者 | computeStatus 读? |
|---|---|---|---|
| `workflow-schema.yaml` | 静态 DAG / gate 定义 | 人(设计期) | 是 |
| `workflow-state.yaml` | 业务/人类状态:params、layers、scope、healing 计数、batch 记录 | 交互前端 + **Conductor(仅执行簿记)**;**Agent 永不写** | 是 |
| 磁盘产物(produces) | 各 phase 实际输出(plans/、tests/、review/…) | agent / CLI-native | 是(决定 done) |
| `events.ndjson` | 执行事件流(dispatch 生命周期、in-flight) | **仅 Conductor** | 否 |
| `execution-graph.json` | events 派生的只读投影 | 仅 Conductor | 否 |

关键澄清:

- **phase "完成" 不是某处的标志位,而是由 engine 从「produces 存在 + gate 裁决」纯函数推导**(现有 `computeStatus` 行为)。agent 写出 produces 即让该 phase 下一轮被算成 done,无需任何人写 "done" 标志。
- **computeStatus 不读 events。** events 仅供 Conductor 调度层做 in-flight 去重与 BLOCKED/失败追踪,**不回灌 engine、绝不影响 gate 裁决**。
- **Conductor 可以写 `workflow-state.yaml` 的执行簿记**(healing 计数、batch、session 指针);**Agent 永远不可写**(§9 permission deny + §12 校验双重拦)。"agent 不碰 workflow-state" 的禁令对 Conductor 不适用——Conductor 是可信确定性代码,不是 LLM。
- 去重公式:`ready = computeStatus().next − in_flight(events) − failed_awaiting_policy − external_pending(events)`。已 dispatch 未完成 → events 标 in-flight → 不重复派;已失败 → 交 §13.1 repair 策略;`external_pending`(local runtime 跳过派发,见 §14/P1-4)由 Conductor 写入 events、调度层读 events 扣除——**computeStatus 仍不读 events**,这些扣减项全在 Conductor 调度层。

## 6. 执行循环 `aws conductor run`

默认顺序,可 `--concurrency N` 有界并发。

```
aws conductor run --change <id> [--runtime local|opencode-command]
                  [--concurrency N] [--no-events]
acquire qa/changes/<id>/orchestration/conductor.lock   # 跨进程互斥;占用则报错退出
loop:
  status = computeStatus()                 # 现有引擎,纯函数,自动从断点恢复
  if status.terminal: break                # completed / stopped
  ready = conductorReady({ next: status.next, events, workflowState, humanInput })  # 完整去重公式见 §5.1
  batch = ready[0..N]                      # N=1 顺序(默认); N>1 有界并发
  for phase in batch (并行/串行):
     if phase ∈ CLI_NATIVE: runCliNative(phase)      # run/inspect/gate/archive,不开 agent
     else:
        brief = compileBrief(phase); write task_brief_created
        write agent_dispatch_started                 # spawn 前写,崩溃后可判 in-flight
        try:
           result = runtime.dispatch(brief)          # local 或 opencode-command
           write agent_dispatch_completed | _failed  # 子进程结束后立即写
           validateTaskResult(brief, result)         # + git-diff + required outputs
           write task_result_validated | _rejected   # validator 后写
        finally:
           updateGraph()
  verdict = checkGate(phase) (有 gate 的)            # 确定性,由 CLI 判
  # verdict==needs_fix → schema repair_of/loop 下一轮自动派 fixer(自愈)
  # verdict==stop/reject 或 result.status==BLOCKED → 干净暂停
```

事件写入时机是恢复正确性的前提(P1-1):`started` 必须在 spawn 前、`completed/failed` 在子进程结束后、`validated/rejected` 在 validator 后。否则 spawn 后 / writeEvents 前崩溃将无法判定该 phase 是否 in-flight。

### 并发安全(N>1 时)

- `in_flight` 去重基于 events,避免重复派发。
- 同批并发 phase 的 `allowed_write_paths` 必须不相交(由 phase_mapping 静态保证,如 api→tests/api、e2e→tests/e2e)。
- **并发 × rollback 硬约束(P0-1)**:patch snapshot 是**全局**工作区快照,与并行 dispatch 冲突——A 失败按全局 patch 回滚可能误伤并发 B 的合法改动,`allowed_write_paths` 不相交也不足以保证全局 patch 安全。v1 硬规则:`opencode-command` runtime 的 `concurrency` **必须为 1**;`local` runtime(不写真文件)可 N>1;`opencode-command` 若要 N>1,**每个 dispatch 必须跑在独立 git worktree / patch sandbox**(非全局 patch)。
- 写 events 串行化(append-only,单写者 = conductor 进程)。
- **跨进程锁(P1-3)** `qa/changes/<id>/orchestration/conductor.lock`(平台文件锁):防止两个 `aws conductor run --change X` 并行重复派发。未获锁即清晰报错退出。**无锁则不得宣称 events 去重成立。**

### 崩溃恢复:stale lock 与 orphaned in-flight(P1-2)

```yaml
lock:
  contains: [pid, hostname, started_at, heartbeat_at]
  stale_after_ms: 1800000
  stale_policy: require --recover-stale-lock      # 不自动抢锁,需显式接管

orphaned_inflight:
  # events 有 agent_dispatch_started 但无 completed/failed
  if started_without_terminal:
    - 若记录了 child pid 且进程已死、或超 timeout → 补写 agent_dispatch_failed(reason=ORPHANED)
    - 再走 §13.1 repair / BLOCKED 策略
```

- Conductor 崩溃后 lock 不会自动失效;`heartbeat_at` 超 `stale_after_ms` 视为 stale,需 `--recover-stale-lock` 显式接管,避免双写。
- 不处理 orphaned in-flight,`in_flight(events)` 会永久扣住该 phase。

## 7. CLI-native vs Agent phase

| 类型 | phase | 执行 |
|---|---|---|
| Agent(开 opencode 新上下文) | case-design / case-review / *-plan / *-plan-review / *-codegen / fix / report-draft / explore | `opencode run` 子进程 |
| CLI-native(不开 agent) | run / inspect / gate-check / archive-eligibility / status | Conductor 直接调现有命令 |

## 8. 交互前端 vs 自动尾段

- **人类决策/反问 phase(≤ Phase 2.5: case-design 等)**:前置在 primary/父 session 交互完成,冻结成 `case.yaml` / `fact-baseline.json`。
- **机械尾段(Phase 3A → 14)**:由 conductor 循环自动跑(正是上下文爆炸区)。
- **中途真未知**:agent 返回 `task-result.status = BLOCKED`,或 gate 判 `needs_human_review` → 循环对该 phase 干净暂停、写 event、其余无依赖 phase 可继续 → 人答(写答案产物)→ 再次 `aws conductor run` 自动从磁盘恢复。
- 严禁 child session 直接拷问用户或伪造答案。

### 8.1 人类输入契约(P1-4:BLOCKED / needs_human_review 恢复)

- 落点:`qa/changes/<id>/orchestration/human-input/<phase>.json`
- schema:`{ phase, question_id, question, answer, answered_by, answered_at }`
- 产生:agent 返回 BLOCKED 时 Conductor 据 task-result 写**待答**条目(answer 留空);或 gate 判 `needs_human_review` 时 Conductor 写出。
- 恢复:`aws conductor run` 重启时,**Conductor 调度层**读该文件,answer 已填则清除该 phase 的 BLOCKED 覆盖、重纳 ready,并把答案作为输入注入下一份 brief。
- 注意:`computeStatus`(现有 engine)不感知 human-input;unblock 识别属 **Conductor 调度层**职责,**不改 engine**。

## 9. Agent 设计:3 个权限档(不按领域)

agent 之间唯一必须静态区分的是 **OpenCode permission 写入地板**(无 per-invocation 权限 flag)。领域/行为下沉到 brief。

| 权限档 agent | 静态写入地板(allow / deny) | 覆盖逻辑 role |
|---|---|---|
| `aws-reviewer`(只读+指定输出) | allow `qa/changes/**/review/**`、`qa/changes/**/inspect/helper-findings/**`、`qa/changes/**/report/**`、`qa/changes/**/notes/**`、`qa/changes/**/orchestration/task-results/**`;deny 其余 | explorer / case-reviewer / plan-reviewer / inspector-helper / report-writer |
| `aws-author`(qa 产物作者) | allow `qa/changes/**/cases/**`、`qa/changes/**/plans/**`、`qa/changes/**/facts/**`、`qa/changes/**/orchestration/task-results/**`;deny tests/src/workflow-state/execution/inspect-failure/gate | case-designer / plan-designer |
| `aws-test-author`(测试代码作者) | allow `tests/**`、`qa/changes/**/healing/**`、`qa/changes/**/orchestration/task-results/**`;deny src/backend/frontend/workflow-state/execution/inspect | api/e2e/fuzz/perf-builder / fixer |

- 路径统一为 **workspace-relative 真实路径**(`qa/changes/**/...`),表与 markdown 示例一致。
- **agent 只能写自己的 `qa/changes/**/orchestration/task-results/<task-id>.json`**;`orchestration/**` 下的 Conductor-owned 文件(events.ndjson、execution-graph.json、task-briefs/**、prompts/**、logs/**、human-input/**)对 agent **永久禁写**(见 §10/§12)。
- `phase → role` 逻辑映射保留(12 role);`role → agent` 塌缩为 3 档。
- 按需增长:若某条细边界后续被证明高危(如 fixer 绝不能碰非测试文件),再单独拆第 4 档。

### Agent markdown(`.opencode/agents/*.md`)

```yaml
---
name: aws-test-author
mode: all
description: Execute a bounded AWS test-authoring brief. Never run gates or decide PASS/FAIL.
permission:
  edit:
    "tests/**": allow
    "qa/changes/**/healing/**": allow
    "qa/changes/**/orchestration/task-results/**": allow   # 只能写自己的 task-result
    "qa/changes/**/orchestration/events.ndjson": deny       # Conductor-owned
    "qa/changes/**/orchestration/execution-graph.json": deny
    "qa/changes/**/orchestration/task-briefs/**": deny
    "qa/changes/**/orchestration/prompts/**": deny
    "qa/changes/**/orchestration/logs/**": deny
    "qa/changes/**/orchestration/human-input/**": deny
    "**": deny
  bash: { "*": deny }
  external_directory: deny
---
You are a bounded AWS worker agent.
You do not own workflow state. You do not read SKILL.md as runtime instruction.
You do not run aws gate check. You do not decide final PASS/FAIL.
You must read the provided task-brief.json and write task-result.json.
You must respect allowed_write_paths.
Report product issue candidates instead of weakening assertions.
```

## 10. 双层写入边界

| | 写在哪 | 内容 | 谁强制 |
|---|---|---|---|
| 角色级粗边界(静态) | agent `.md` 的 `permission` | role 不变的产品代码/真相文件禁区 | OpenCode 运行时拦截(**硬度待 §24.1 验证**,见 P0-2) |
| 任务级细边界(动态) | brief 的 `allowed_write_paths` | 含 `<change-id>` 的具体路径 | result_validator + git-diff(事后) |

**Read 边界说明(P1-6)**:OpenCode 的 `permission.read` 可按 glob 控制(如 `"skills/**": deny`),但"agent 不读 SKILL.md 作为 runtime instruction"主要是 **prompt/advisory 规则**,**不应当作硬安全边界**。真正的硬边界是 write/gate 三道校验(permission deny + result_validator + git-diff + 确定性 gate)。可选地用 `read` glob 收紧,但不依赖它做安全保证。

## 11. 契约

单一真相源:Zod 定义 → 用 `zod-to-json-schema` 生成 `schemas/*.schema.json`(JSON schema 视为产物)。TS 类型由 Zod 推导。

### task-brief.json

字段(摘要):`schema_version, task_id, change_id, session_id, parent_node_id?, node_id, phase, logical_role, runtime_agent, title, goal, inputs[], outputs[], task_result_path, allowed_write_paths[], readonly_paths[], forbidden_actions[], quality_rules[], evidence_requirements[], command_policy, timeout_ms, created_at, created_by`。

> **`task_result_path`(P1-3,强字段)**:`qa/changes/<id>/orchestration/task-results/<task-id>.json`。模板用 `{{result_path}}` 即取此值。validator 校验:runtime `resultPath` == `brief.task_result_path`、task-result 实际落点 == `brief.task_result_path`、agent 不得写其他 task-id 的 result(防写错 task-id 或默认路径)。

> **P0-4 字段拆分**:`logical_role`=逻辑角色(如 `aws-api-builder`,用于映射/审计/规则抽取);`runtime_agent`=实际 OpenCode agent 文件名(3 档之一,如 `aws-test-author`)。runtime 模板**只能**用 `{{runtime_agent}}` 去 `--agent`,严禁用 `logical_role`(否则 `.opencode/agents/` 找不到 agent)。

强制:`command_policy.may_run_aws_gate === false`、`command_policy.may_modify_workflow_state === false`。

写入:`qa/changes/<id>/orchestration/task-briefs/<task-id>.json`;同时生成 `prompts/<task-id>.md`(含 bounded-worker 必做/禁做清单)。

### task-result.json

字段(摘要):`schema_version, task_id, change_id, node_id, logical_role, runtime_agent, phase, status(TaskResultStatus = SUCCESS|FAILED|PARTIAL|BLOCKED), summary, files_created[], files_modified[], files_read?, evidence[], findings?[], known_product_issue_candidates?[], policy_violations?[], completed_at`。

### conductor-event.ndjson / execution-graph.json

- 事件类型:`session_started, phase_selected, task_brief_created, agent_dispatch_started, agent_dispatch_completed, agent_dispatch_failed, agent_dispatch_skipped, cli_phase_started, cli_phase_completed, cli_phase_failed, task_result_validated, task_result_rejected, gate_handoff, session_completed`。append-only,每行一个 JSON。
- **CLI-native phase(无 agent)用 `cli_phase_*`(P1-4)**,其 `agent`/`task_id` 字段为空,保证 OpenChamber 树渲染时 CLI-native 节点的运行态完整(started→completed/failed→gate_handoff)。
- **每条 event 的最小 payload(P1-4,orphan recovery 必需)**:
```json
{
  "event_id": "...", "type": "agent_dispatch_started",
  "change_id": "...", "phase": "...", "task_id": "...", "node_id": "...",
  "logical_role": "...", "runtime_agent": "...", "runtime": "opencode-command",
  "child_pid": 12345, "started_at": "...", "timeout_ms": 900000,
  "result_path": "qa/changes/<id>/orchestration/task-results/<task-id>.json",
  "artifact_paths": {}
}
```
`agent_dispatch_started` 必须带 `child_pid / runtime / timeout_ms / started_at / result_path`,否则 §6 崩溃恢复无法判定 orphaned in-flight。`cli_phase_*` 的 `task_id / runtime_agent / child_pid` 为空。
- graph:`nodes[]`(session|phase|agent|gate, status, artifact_paths)+ `edges[]`(contains|depends_on|handoff)。**只读投影,绝不参与 gate 裁决。**

## 12. 校验(三道)

1. **OpenCode permission 地板**(见 §9/§10)。⚠️ **是否为"运行时硬拦"取决于 §24.1 的 P0 验证**:`--dangerously-skip-permissions` 的语义是"自动批准**未被显式 deny** 的权限"(1.16.2 help 原文),据此显式 `deny` 应仍生效;但**未经 §24.1 集成测试证实前,本道仅可称为 prompt policy**,真正硬边界以第 2、3 道为准。
2. **result_validator**:task_id/change_id/phase/logical_role/runtime_agent 匹配;result 实际落点 == `brief.task_result_path`(agent 不得写其他 task-id 的 result);files_created/modified ⊆ allowed_write_paths;**brief.outputs[] 的 required output 必须真实存在(`required_outputs_exist`)、符合 schema(`required_outputs_match_schema`)、且落在 allowed_write_paths 内(`required_outputs_within_allowed_write_paths`)——缺 required output 即使 status=SUCCESS 也判 reject**(否则 computeStatus 永远看不到 produces → 重复派发);禁含 `workflow-state.yaml`、`execution/quality-gate-result.json`、`inspect/failure-analysis.json`(除非 brief 显式授权 helper findings 且不覆盖正式件);缺必填 evidence → fail-closed;command log 出现 `aws gate check` → fail-closed。校验失败写 `task_result_rejected`。
3. **git-diff 实际改动校验**:dispatch 前后快照对比,用**实际改动集**(而非自报字段)再过一遍 path policy,防"沉默越界"。

`path_policy.isPathAllowed`:normalize、禁 `..` 逃逸、禁绝对路径(除非显式配置)、复用 `minimatch`;`workflow-state.yaml` / `quality-gate-result.json` 永久禁;`failure-analysis.json` 默认禁;**Conductor-owned orchestration 永久禁 agent 写**:`orchestration/events.ndjson`、`orchestration/execution-graph.json`、`orchestration/task-briefs/**`、`orchestration/prompts/**`、`orchestration/logs/**`、`orchestration/human-input/**`(agent 仅可写 `orchestration/task-results/<task-id>.json`)。

### 12.1 Dispatch 事务与回滚(P0-3)

每次 dispatch 是一个事务;reject 必须清理污染,不得把脏工作区留给后续 phase:

```
before:    保存 dispatch 前完整"内容"快照(不只是状态):
             - tracked  → git diff(含已暂存)+ 索引状态 = 完整可逆 patch
             - untracked → 路径清单 + 内容备份(拷贝或 hash+backup)
on_success(三道校验全过):
           接受 diff;写 task_result_validated
on_rejected(任一道失败):
           写 task_result_rejected
           越界/未授权文件 → 移入 qa/changes/<id>/orchestration/rejected/<task-id>/
           被改 tracked 文件 → 按 before patch 精确还原到 dispatch 前"内容"
                              (严禁 git restore 到 HEAD——会回滚上一阶段已接受的合法未提交改动)
           本次新建的越界 untracked 文件 → 删除
           phase → 标记 BLOCKED 或 NEEDS_FIX
precondition(下一 phase 前):
           policy_clean_workspace 必须成立,否则拒绝继续(dirty-block)
```

- **v1 必做(非后续增强)**:patch snapshot 精确回滚。`git status --porcelain` 只记状态不记内容,**不能**用它做 `git restore`——会误伤上一阶段已接受的合法未提交改动。必须按 before patch 还原到"dispatch 前内容"。
- **`policy_clean_workspace`(P1-2,**非** `git status` clean)**:允许上一阶段**已验证接受**的合法未提交改动存在,也允许 `orchestration/rejected/<task-id>/`(合法审计 quarantine)存在;判定 = 无未授权改动 + 无未归属任何 task 的新增文件 + **无未处理的 rejected 残留**。**严禁**用 `git status --porcelain` 直接判 clean(会把合法累积改动误判为脏)。
- **quarantine manifest(P0-3,消歧)**:`orchestration/rejected/<task-id>/` 是**合法审计产物,不算 dirty**;每个该目录必须含 `manifest.json` = `{ task_id, status: OPEN|CLOSED, quarantined_files[], restored_files[], deleted_files[], created_at, closed_at? }`。缺 manifest 或 `status != CLOSED` → 视为**未处理 rejected 残留** → dirty-block。
- **与 `--concurrency` 的关系(P0-1)**:patch snapshot 是全局工作区操作,只在 `concurrency=1` 下安全;`opencode-command` 并发 >1 必须改用 per-dispatch worktree/sandbox(见 §6 并发安全)。
- 增强:每个 subagent 在临时 git worktree / patch sandbox 执行,validate 通过后再 apply patch(更强隔离);v1 顺序模式用 patch snapshot 即可达到同等正确性。
- 若 §24.1 不通过(permission 非硬拦),本事务回滚 + git-diff + policy_clean_workspace 即为真正硬边界。

## 13. 硬规则下沉为确定性 gate

case_id 绑定、命名 `test_<case_id_lowercase>__*`、断言不得弱化等,**不依赖 agent 记忆**(fresh 上下文尤其不可靠),改为确定性 gate check(复用 `src/core/case_id.ts` 的 `caseIdTextMatcher` 扫测试函数名)。绑不上 in-scope case_id → gate needs_fix → 自动派 fixer。

### 13.1 自愈上限(P1-5)

```yaml
repair_policy:
  max_attempts_per_phase: 2
  max_total_attempts: 5
  on_exceeded: BLOCKED      # 超限即暂停交人,不无限循环
```

复用现有 `workflow-state.yaml` 的 healing 计数 + engine `healingSummary`(`max_healing_attempts` param)。产品 bug 被误判为测试 bug 时,上限确保停在 BLOCKED 而非无限派 fixer。

## 14. Runtime Adapter

中性接口 `SubagentRuntimeAdapter.dispatch(input) -> { status: RuntimeDispatchStatus, exitCode?, stdoutPath?, stderrPath?, resultPath?, message? }`。

**两个层级的状态枚举不可混用(P1-1):**

- `RuntimeDispatchStatus = COMPLETED | FAILED | TIMEOUT | PENDING_EXTERNAL`(adapter 返回,描述"进程/派发"结果)。
- `TaskResultStatus = SUCCESS | FAILED | PARTIAL | BLOCKED`(agent 写在 task-result.json,描述"任务"结果)。
- Conductor 据二者联合判定:`dispatch=COMPLETED` 但 `result.status=FAILED/BLOCKED` 走对应分支;`dispatch=PENDING_EXTERNAL`(local)则不期待 result。

### local_runtime

只生成 brief/prompt/event/graph,不调用 agent,返回 `PENDING_EXTERNAL`。用于 CI 确定性 smoke 与全部编排逻辑的可测性。

**循环行为(P1-4):** dispatch 返回 `PENDING_EXTERNAL` 后,Conductor 写 `task_brief_created` + `agent_dispatch_skipped`,该 phase 标 `external_pending`,本次 run **跳到其他 ready phase**(无则停止),**不重复生成同一 brief**(除非 `--force`)。避免因 produces 不出现而无限重派同一 phase。

### opencode_command_runtime

`child_process.spawn`,命令由配置模板注入(不写死)。stdout/stderr 写 `orchestration/logs/<task-id>.{stdout,stderr}.log`;timeout kill;命令不存在/未配置不 crash(清晰报错或按 CLI 参数回退 local)。result 存在→COMPLETED;exit 0 但无 result→FAILED。

**已验证 opencode 1.16.2**:`--agent/--file/--format/--dir` 均存在;非停必须加 `--dangerously-skip-permissions`;不传 `--continue/--session` 即新会话(=新上下文);`.opencode/agents/`(复数)目录名正确;`mode` 默认 `all`。

**安全:结构化 argv,禁 shell 注入(P1-3)。** 用 `spawn(bin, args, { shell: false })`,**不用字符串拼接模板**;变量渲染成 argv array,逐个 normalize + allowlist 校验,不允许未声明变量。路径变量(project_root/brief_path/result_path)含空格安全;change_id 等先 allowlist 再注入。默认结构(`--agent` 只用 `{{runtime_agent}}`,见 P0-4):
```yaml
command:
  bin: opencode
  args: [run, --dir, "{{project_root}}", --agent, "{{runtime_agent}}",
         --file, "{{brief_path}}", --format, json, --dangerously-skip-permissions,
         "Read the attached task-brief.json and execute only that task. Write task-result.json to {{result_path}}."]
```

## 15. 双派发路径(同一契约)

| | CI/headless | 交互/UI(OpenChamber) |
|---|---|---|
| 启动 | conductor 循环 spawn `opencode run` | primary(可为 Sisyphus)用 Task 工具 @aws-subagent |
| UI 呈现 | 各自独立 session + 渲染 `execution-graph.json` 成树 | OpenCode 原生 parent→child session 树 |
| 反问 | BLOCKED 暂停回 CLI | 在父 session 主聊天里进行,人答 |

OpenChamber 仅为 OpenCode 的 UI 前端(连 OpenCode server),无独立 agent 运行时。

## 16. 与 OMO 的关系(不硬依赖,选择性集成)

| OMO 能力 | 对 bounded agent | 处理 |
|---|---|---|
| 编排纪律(Ralph loop / Todo Enforcer / IntentGate) | 有害(推其越界/不停/改写意图) | 用 OMO `disabled_hooks` 关闭 |
| 执行工具(Hashline 编辑 / LSP / ast-grep / comment-checker) | 有益(提升 codegen 质量) | 在场则用,baseline 用 OpenCode 内置,不硬依赖 |

- `--pure` 太粗暴(连有益工具一起关),仅用于纯只读 reviewer 或无 OMO baseline;codegen agent 用"留工具 + 关编排 hook"。
- Sisyphus 与 aws-agent 共存且互补:Sisyphus 可作编排者 @调用 aws-agent。`--pure` 是单进程级、可选,不影响交互会话里的 Sisyphus。
- 命名 `aws-` 前缀,与 OMO agent 无冲突。
- **配置契约 + 诚实声明(P1-5)**:`disabled_hooks` 写在 `.aws/config.yaml` 的 `subagents.omo`(见 §19),由 `aws init` 落地。**但 `opencode-command` runtime 无法在运行时强制 OMO 关闭 hook**——是否生效取决于 OMO 是否读取该项目配置。v1 视为**文档/配置建议**,不保证 conductor 能控制 OMO hook;不得让实现者误以为 conductor 已能运行时管控 OMO。

## 17. 新增目录与文件

```
src/orchestration/subagents/  roles.ts phase_mapping.ts task_brief.ts task_result.ts
                              brief_builder.ts result_validator.ts path_policy.ts forbidden_actions.ts
src/orchestration/events/     event_schema.ts event_writer.ts graph_writer.ts
src/orchestration/runtime/    runtime_adapter.ts local_runtime.ts opencode_command_runtime.ts
src/commands/conductor.ts     (注册到 src/cli.ts)
schemas/                      task-brief / task-result / conductor-event / execution-graph .schema.json (生成)
.opencode/agents/             aws-reviewer.md aws-author.md aws-test-author.md
```

复用现有 `src/orchestration`,不重复造 DAG 概念。

## 18. CLI 命令

- `aws conductor brief --change --phase [--agent --session --parent-node --out --format --no-events]`:只生成 brief+prompt(+event/graph)。
- `aws conductor dispatch --change --phase [--runtime --timeout-ms --force]`:brief + 调 runtime + validate。
- `aws conductor run --change [--runtime --concurrency --recover-stale-lock --force --dry-run]`:完整循环(§6)。
- `aws conductor pending --change`:列出 external_pending / BLOCKED / orphaned 待处理项。
- `aws conductor unblock --change --phase --answer-file`:写 human-input 答案(§8.1)并清除 BLOCKED。
- `aws conductor validate-result --brief --result`。
- `aws conductor graph --change`:由 events 重建 graph。

### 参数安全约束

- **`--no-validate` 已移除(P0-1)**:`git-diff / path policy / required_outputs / rollback` 永不可跳过。仅单元测试 fixture 可用 `--skip-schema-validation-for-test-only`(且只对 `local` runtime 生效,**绝不跳 git-diff / path policy**);`opencode-command` 一律全量校验。
- **`--no-events` 限制(P0-2)**:仅 `conductor brief` / `--dry-run` 可用。`conductor run` + `opencode-command` **禁止** `--no-events`(events 承载 in-flight / external_pending / crash-recovery / orphaned 恢复)。`local` runtime 可用 `--no-events`,但此时**不得宣称支持 resume / in-flight / external_pending**。
- **command 覆盖(P1-3)**:CLI **不提供** `--command-template`(与结构化 argv 冲突);v1 command 只从 `.aws/config.yaml` 的 `subagents.command`(`bin` + `args[]`)读取。

## 19. 配置 `.aws/config.yaml`

```yaml
subagents:
  runtime: local                   # P1-5:默认保守(不写真文件);显式改 opencode-command 才派发
  permission_mode: advisory        # advisory | hard;hard 需 §24.1 三组验证通过才可设
  timeout_ms: 900000
  concurrency: 1                   # 默认顺序
  command:                         # 结构化 argv,shell:false(P1-3)
    bin: opencode
    args: [run, --dir, "{{project_root}}", --agent, "{{runtime_agent}}",
           --file, "{{brief_path}}", --format, json, --dangerously-skip-permissions,
           "Read the attached task-brief.json and execute only that task. Write task-result.json to {{result_path}}."]
  omo:                             # P1-5:配置契约(非运行时强制,见 §16)
    enabled: auto
    disabled_hooks: [todo-continuation-enforcer, intent-gate, ralph-loop, preemptive-task-expansion]
```

- **默认 `runtime: local`(P1-5)**:用户显式切到 `opencode-command` 才真派发。
- **`permission_mode`**:默认 `advisory`(硬边界 = validator + git-diff + rollback);设 `hard` 前必须先跑 §24.1 三组 permission probe。
- **能力探测**:首次以 `opencode-command` 运行时自动执行 §24.1 probe,结果写 `qa/changes/<id>/orchestration/runtime-capabilities.json`(`{ permission_enforced: bool, probed_at, opencode_version }`);`permission_mode: hard` 与该结果不符则拒绝以 hard 启动。
- 不出现 `omo run`,不要求启动 OMO runtime。

## 20. Skill 改动

- **大部分 phase skill 不改**(继续做 inline 真相源)。
- **新增「Portable Rules / Agent Contract」节**到每个可执行 phase skill:集中标注必须进 brief 的硬规则(case_id 命名、断言要求、evidence、allowed paths),供 `brief_builder` 忠实抽取,治"编译有损"。
- **aws-workflow 轻改**:注明 document-driven 路径由 `aws conductor` 实现;既有"subagent 不得加载 skill / 不写 workflow-state / 不判 gate"禁令继续有效并改由运行时 + permission 强制;inline 路径保留为默认,conductor 为增量。

## 21. init 集成

- 把 `.opencode/agents`(3 个)纳入 `aws init` 复制范围;同名不覆盖、打印 warning;`aws init --repair` 补齐缺失;`--agent` 仅在项目存在该文件时解析。

## 22. 文档

- 本 spec 位于 `docs/superpowers/specs/`(已被 `.gitignore` 的 `!docs/superpowers/` 例外覆盖,可跟踪)。
- 说明文档放 `docs/superpowers/opencode-subagent-dispatch.md`(同被例外覆盖):无独立 OMO runtime、conductor 调 OpenCode command、OMO 若装为 plugin、aws agents 为自定义 role。避免落在 `docs/` 根下被忽略。

## 23. 测试(Jest)

- phase mapping(含 unknown phase 报错)、brief builder(role/forbidden/may_run_aws_gate=false/allowed paths/输出落点)、path policy(允许/拒 workflow-state/拒 gate-result/拒 `..`/拒绝对路径)、result validator(匹配/越界/workflow-state/gate-result/缺 evidence)、event writer(append-only、行 JSON、graph 构建)、runtime adapter(local 返回 PENDING_EXTERNAL、变量展开、日志、timeout kill、exit0 无 result→FAILED)、CLI smoke(`conductor brief`/`graph` exit 0 且产物存在)、循环(顺序 + `--concurrency` 有界并发 + in-flight 去重 + BLOCKED 暂停 + needs_fix 自愈路由)。
- **brief_builder golden tests(P1-2)**:api/e2e-codegen brief 必含 case_id 命名规则;必含 token header 规则;`allowed_write_paths` 与 phase_mapping 一致;`forbidden_actions` 含 `aws gate check` 与 workflow-state 修改;`runtime_agent` 解析到存在的 `.opencode/agents/*.md`。
- **事务/回滚(P0-3)**:reject 后越界文件被移入 `rejected/`、tracked 文件 restore、untracked 删除、工作区恢复 clean、dirty-block 生效。
- **跨进程锁(P1-3)**:第二个 `conductor run --change X` 获锁失败并退出。
- **人类输入恢复(P1-4)**:写入 human-input answer 后 resume 能 unblock 并把答案注入下一份 brief。
- **repair 上限(P1-5)**:超过 `max_attempts` 后 phase=BLOCKED,不再派 fixer。
- **required outputs(P0-3)**:status=SUCCESS 但缺 brief.outputs[] required output → reject;输出不在 allowed_write_paths → reject。
- **patch 回滚(P0-1)**:dispatch 前已有上一阶段未提交合法改动,reject 后该合法改动**不被回滚**,只精确撤销本次越界改动。
- **结构化 argv(P1-3)**:含空格路径正确传参;`shell:false`;未声明变量拒绝渲染。
- **崩溃恢复(P1-2)**:stale lock 非 `--recover-stale-lock` 不接管;`started` 无 terminal event → 补 `agent_dispatch_failed(ORPHANED)`。
- **local 外部待办(P1-4)**:`--runtime local` 写 `agent_dispatch_skipped` + `external_pending`,`ready` 公式扣除 external_pending,同 phase 不重复出 brief(除非 `--force`)。
- **并发约束(P0-1)**:`opencode-command` + `concurrency>1` 且无 worktree → 拒绝启动(或强制降为 1 并 warning)。
- **task_result_path(P1-3)**:result 落点 ≠ `brief.task_result_path` → reject;写其他 task-id 的 result → reject。
- **permission precedence(P0-2/§24.1)**:positive 写 task-results 成功;negative 写 src/产品代码失败;conductor-owned events.ndjson 失败。
- **CLI-native 事件(P1-4)**:`cli_phase_started/completed/failed` 正确写出,graph 节点运行态完整。
- **参数安全(P0-1/P0-2)**:`opencode-command` 拒绝 `--skip-schema-validation-for-test-only`;`conductor run` + `opencode-command` 拒绝 `--no-events`;`--skip-schema-*` 不跳 git-diff/path policy。
- **quarantine manifest(P0-3)**:`rejected/<id>/` 有 `manifest.status=CLOSED` 不触发 dirty-block;缺 manifest / `status=OPEN` → dirty-block。
- **event 最小字段(P1-4)**:`agent_dispatch_started` 含 child_pid/runtime/timeout_ms/started_at/result_path;orphan recovery 据此重建。
- **默认 runtime(P1-5)**:config 默认 `local`;`permission_mode: hard` 在 probe 未通过时拒绝启动。

## 24. 验收

`npm run build && npm run lint && npm test`。现有测试失败需判定是否本次引入,不随意删测/改 snapshot。

### 24.1 permission 行为验证(分层门禁)

**三组集成测试(`--dangerously-skip-permissions` 模式,验证 allow/deny precedence,P0-2):**

1. **positive**:`aws-test-author` 写允许路径 `qa/changes/<id>/orchestration/task-results/<task-id>.json` → **必须成功**(确认 allow 不被 `**: deny` 覆盖)。
2. **negative(产品代码)**:写 `src/backend/foo.py` → **必须失败**。
3. **conductor-owned negative**:写 `qa/changes/<id>/orchestration/events.ndjson` → **必须失败**。

**分层门禁(P0-3:不阻断全部实现,只阻断"把 permission 当硬拦"):**

| 组件 | 是否依赖 §24.1 |
|---|---|
| local_runtime / validator / conductor core | 否,可先实现 |
| opencode_command_runtime(hard-permission mode) | **三组全过**才能启用 |

**若 §24.1 不通过**:opencode_command_runtime 仍可实现,但 ——

- 不得宣称 permission 为 hard boundary(§12 第 1 道降级为 advisory);
- **强制**启用 patch snapshot + git-diff + `policy_clean_workspace`(§12.1)作为真正硬边界;
- 文档标记 permission 为 advisory。

## 25. 已知限制

- fresh 上下文 codegen 看不到 plan 作者隐式推理 → 依赖 plan 自足 + fact-baseline + gate 兜底。
- 有界并发会丢失部分跨 phase 顺序直觉,默认顺序规避。
- `opencode run` flag 依赖 1.16.2 实测;升级需复核模板。
- JSON schema 由 Zod 生成,需在 build 流程固化生成步骤以防漂移。

## 26. 后续建议

- 先内部用 `local` runtime 跑通全循环与契约,再接 `opencode-command`。
- OpenChamber 自定义面板渲染 `execution-graph.json`,让 headless 跑也有树视图。
- 评估是否把更多硬规则下沉为 gate,持续降低对 agent 记忆的依赖。
