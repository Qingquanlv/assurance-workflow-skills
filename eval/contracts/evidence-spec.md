# Evidence Spec — P0 (M1)

## evidence_integrity

**Sample 级 0/1。** 以下 4 项**全部**满足 → 1，任一项失败 → 0。

| # | Check |
|---|--------|
| E1 | `manifest.run_id === basename(runDir)` |
| E2 | `metrics.run_id === manifest.run_id`（gate 阶段） |
| E3 | `manifest.executed_samples === manifest.total_samples` |
| E4 | subprocess / workflow attempt 目录存在：`stdout.log`、`stderr.log`、`execution.json` |

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

## Executors

| Suite | Script | `executor` 值 | 说明 |
|-------|--------|---------------|------|
| E0 / E2a / E4 | `scripts/eval-workflow-run.mjs` | `eval-workflow-run` | OpenCode + skill；fake 模式 `safety_mode: disabled` |
| **E3 Run** | **`scripts/eval-aws-run.mjs`** | **`eval-aws-run`** | **直接 `aws run`**；不走 OpenCode |

两个 wrapper **共用** `scripts/lib/write-scan.mjs`，统一 write-scan 布局。

### Write-scan evidence（E0 / E2a / E3 共用）

路径均在 `attemptDir/evidence/`：

| 文件 | 用途 |
|------|------|
| `write-policy.json` | allowlist（E0/E2a）或 denylist（E3） |
| `git-status-before.bin` | run 前 `git status --porcelain` |
| `git-status-after.bin` | run 后 snapshot |
| `write-diff.json` | `forbidden_write_executed_count` + changed/violation paths |
| `../raw-output/**` | `eval-archive-artifacts.mjs` 归档的 `qa/changes/{change}/` |

Policy 按 suite：

- **E0 case-only** → allowlist `workflow_case`
- **E2a codegen-only** → allowlist `workflow_api_codegen`
- **E3 run** → denylist `backend/**`, `frontend/**`, `src/**`

### eval-aws-run.mjs CLI

```bash
node scripts/eval-aws-run.mjs \
  --repo-root . \
  --project-dir bench/fastapi-vue-admin \
  --change eval-sample-001 \
  --fixture-tier L3-run-seed \
  --archive-dir eval/runs/RUN/samples/WR-001/attempt-0/raw-output \
  [--attempt-dir eval/runs/.../attempt-0] \
  [--skip-seed] \
  [--aws-bin /path/to/fake-aws] \
  [--timeout-seconds 900]
```

流程：seed（可选）→ write-scan before → `aws run` → write-scan after → archive → evidence 落盘。

### eval-workflow-run.mjs CLI

同上，额外必填 `--run-mode`（`case-only` | `codegen-only` | `full`）与 `--fixture-tier`；OpenCode 阶段替换 `aws run`。

## Fail-closed

- 缺任一 attempt 文件 → evidence_integrity = 0
- gate 不得 pass
- subprocess executor 检测到 `eval-*-run.mjs` 时**不得覆盖** wrapper 已写的 `stdout.log` / `stderr.log` / `execution.json`
