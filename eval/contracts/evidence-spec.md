# Evidence Spec — P0 (M1)

## evidence_integrity

**Sample 级 0/1。** 以下 4 项**全部**满足 → 1，任一项失败 → 0。

| # | Check |
|---|--------|
| E1 | `manifest.run_id === basename(runDir)` |
| E2 | `metrics.run_id === manifest.run_id`（gate 阶段） |
| E3 | `manifest.executed_samples === manifest.total_samples` |
| E4 | subprocess / workflow attempt 目录存在：`stdout.log`、`stderr.log`、`execution.json` |

> `process-summary.json`（`eval-workflow-run` 过程可观测性产物）为 **observe-only**，**不**计入 `evidence_integrity` 必需文件；缺失时 process 指标降级为 `process_observability_available=0`，旧 run 报告照常生成（见设计 §13/§16）。

### execution.json 必填字段（workflow subprocess）

```json
{
  "executor": "eval-workflow-run",
  "command": ["..."],
  "cwd": "...",
  "exit_code": 0,
  "wrapper_exit_code": 0,
  "opencode_exit_code": 0,
  "signal": null,
  "duration_ms": 12345,
  "timed_out": false,
  "safety_mode": "enabled",
  "archive_completed": true,
  "evidence_completed": true
}
```

E3 `eval-aws-run` 将 `opencode_exit_code` 换为 `aws_run_exit_code`。

### Exit code policy（P0-2）

| 场景 | wrapper `exit_code` / process exit |
|------|-------------------------------------|
| seed / git / archive / evidence 基础设施失败 | **1** |
| inner command（OpenCode / `aws run`）非 0，但 archive + evidence 成功 | **0** |
| inner command 非 0 值 | 写入 `opencode_exit_code` 或 `aws_run_exit_code`；**由 scorer/gate 判定** |

Eval 评估的是归档产物与证据，不让 subprocess exit code 短路 scorer。

### Evidence 写入顺序（P0）

两个 wrapper 必须按序落盘，**execution.json 最后写**：

1. spawn inner command（OpenCode / `aws run`）
2. 立即写 `stdout.log` / `stderr.log`
3. write-scan after → `evidence_completed` 就绪（`evidence/write-diff.json` 等）
4. archive → `archive_completed` 就绪
5. 写 `execution.json`（此时 `archive_completed` / `evidence_completed` 为真实值）
6. `process.exit(wrapper_exit_code)`

archive 失败时：`evidence_completed: true`、`archive_completed: false`、`wrapper_exit_code: 1`；不得提前写入 `archive_completed: true`。

**`eval-workflow-run` 附加过程可观测性落盘**（设计见 `docs/design/eval-opencode-process-observability.md`）。在步骤 3 之后、步骤 5（`execution.json`）之前，额外解析 OpenCode NDJSON 并写 attempt 根的 `process-summary.json`（与 `execution.json` 同级），使 `execution.json` 仍是最后写入的原子完成标记：

1. spawn OpenCode
2. 立即写 `stdout.log` / `stderr.log`
3. write-scan after → `evidence/write-diff.json`
4. 解析 OpenCode summary + 用 write-diff 完成严格 bypass correlation → 写 `process-summary.json`
5. archive
6. 写 `execution.json`（新增 session 字段，见下）
7. `process.exit(wrapper_exit_code)`

过程解析失败**不得**改变 `wrapper_exit_code` / `opencode_exit_code`，也不得覆盖已写的 `stdout.log` / `stderr.log`；此时 `process-summary.json.observability_available = false`。`eval-aws-run` 不产出 `process-summary.json`。

### execution.json 过程可观测性字段（仅 `eval-workflow-run`）

```json
{
  "session_id": "ses_xxx | null",
  "session_resume_command": "opencode <sut-dir> --session ses_xxx | null",
  "session_export_command": "opencode export ses_xxx | null",
  "process_observability_available": true,
  "process_summary_path": "process-summary.json"
}
```

## Executors

| Suite | Compiled implementation | `execution.json.executor` | 说明 |
|-------|--------|---------------|------|
| E0 / E2a / E4 | `src/eval/executors/workflow_run.ts`（suite `type: workflow-run`） | `eval-workflow-run` | 默认 `aws workflow run --adapter headless`；fake 模式 one-shot golden；`entry: orchestrator` 遗留 OpenCode |
| **E3 Run** | **`src/eval/executors/aws_run.ts`（suite `type: aws-run`）** | **`eval-aws-run`** | **直接 `aws run`**；不走 OpenCode |

两个编译 executor **共用** `src/eval/write_scan.ts`，统一 write-scan 布局。

### Write-scan evidence（E0 / E2a / E3 共用）

路径均在 `attemptDir/evidence/`：

| 文件 | 用途 |
|------|------|
| `write-policy.json` | allowlist（E0/E2a）或 denylist（E3） |
| `git-status-before.bin` | run 前 `git status --porcelain` |
| `git-status-after.bin` | run 后 snapshot |
| `write-diff.json` | `forbidden_write_executed_count` + changed/violation paths |
| `../raw-output/**` | `src/eval/archive_artifacts.ts` 归档的 `qa/changes/{change}/` |

Policy 按 suite：

- **E0 case-only** → allowlist `workflow_case`
- **E2a codegen-only** → allowlist `workflow_api_codegen`
- **E3 run** → denylist `backend/**`, `frontend/**`, `src/**`

### aws-run suite 配置

```yaml
executor:
  type: aws-run
  timeout_seconds: 900
  expected_outputs:
    - "{{attempt.dir}}/raw-output/archive-manifest.json"
```

流程：seed（可选）→ write-scan before → `aws run` → write-scan after → archive → evidence 落盘。

### Compiled `workflow-run` executor

Harness 根据 suite 的 `executor.type: workflow-run` 直接调用
`src/eval/executors/workflow_run.ts`，并从 attempt context 与 sample 注入 project、change、
fixture 和 archive 路径。suite 只声明结构化的 `run_mode`、可选单值 `test_type` 及 policy。

默认 `--entry driver`：调用 `aws workflow run --adapter headless`（可用 `--aws-bin` /
`--agent-cmd` 覆盖）。`EVAL_USE_FAKE_OPENCODE=1` 仍走 one-shot golden stub（CI smoke）。
遗留对照：`--entry orchestrator` / `phase-skill` 仍用 OpenCode + skill prompt。

## Fail-closed

- 缺任一 attempt 文件 → evidence_integrity = 0
- gate 不得 pass
- `workflow-run` / `aws-run` 是显式 external-evidence writer；harness **不得覆盖**它们写入的
  `stdout.log` / `stderr.log` / `execution.json`。普通 subprocess 不使用文件名推断。
