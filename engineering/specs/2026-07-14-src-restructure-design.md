# src 目录大重构设计（方案 2：一次性做到终态）

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

> 日期：2026-07-14
> 背景：对标 browser-use 的功能包结构（每个功能一个包，`cli.py` 薄层），
> 本仓库的 workflow 内核被切成 core / orchestration / driver / execution / report / templates
> 六个顶级目录，且 eval executor 与 retro-nightly 的模块真身长在 `scripts/`（不编译、
> 不受测试覆盖）。本设计承接 `engineering/design/structure-cleanup-candidates.md` 的候选 A / B，
> 并将押后的候选 C 升级为"内核簇整体合并"，一个 PR 系列一次做完。

## 0. 决策记录

- **范围**：整体重组（候选 A + B + 内核合并 + scripts 清场 + eval 数据目录整理）。
- **执行方式**：方案 2 —— 一把梭大重构，import 路径只改一次，不留中间态。
- **行为约束**：允许小幅命令面变化（retro-nightly 变 `aws retro nightly` 子命令、
  suite YAML 改 `executor.type` 声明）；eval verdict / metrics 等运行结果必须前后一致。
- **依赖数据支撑**（depcruise 全 src 扫描）：core↔orchestration（14/9）、
  core↔execution（12/3）、core↔templates（2/4）、execution↔report（3/1）四组循环依赖
  全部落在内核簇内部 —— 证明这六个目录本来就是一个模块，合并是承认现实。
  `eval/`、`retro/`、`risk/` 是干净的单向消费者；`commands/` 是标准薄 CLI 层，结构健康。
- **前置条件已满足**：候选 C 当时押后是等 progression 接口定型；
  `boundary-inventory.md` §7 显示 round-2（`inspect → dispatch → advance` 主循环收敛）
  已落地，合并不再有返工风险。

## 1. 目标目录终态

```
src/
  cli.ts
  commands/                  # 薄 CLI 层，不变（对齐 browser-use 的 cli.py）
  workflow/                  # 内核大包（六目录合并，见 §2）
    core/  orchestration/  driver/  execution/  report/  templates/
  eval/                      # 收编 executor 后的完整 eval harness（见 §3）
    executors/  judge/  scorers/  ...
  retro/                     # nightly 转 TS 子命令（见 §4）
  risk/
  schema/                    # 工件 schema SSOT，保留共享层
  utils/
scripts/                     # 只剩 3 个薄文件（见 §5）
eval/                        # 配置与数据；输出统一进 eval/out/（见 §6）
```

## 2. 内核合并 `src/workflow/`

六个内核目录本身纯移动 + 改 import。**本次不解 workflow 包内部循环依赖**：四组循环
合进同一个包后降级为包内问题，后续按需逐步理顺（depcruise 规则对 workflow 包内循环
暂豁免，见 §7）。但现有 `src/orchestration/engine.ts → src/schema/ → src/core/types.ts`
会在平移后形成 `workflow ↔ schema` 包循环，必须在同一 commit 内先消除，不能纳入包内豁免。

依赖方向固定为 **`workflow → schema` 单向**：

- `src/schema/` 是工件契约的共享下层，允许 workflow 调用 schema 校验器；
- schema 禁止 import `src/workflow/**`，包括 `import type`；
- 将 `ExecutionManifest`、`FailureAnalysis`、`QualityGateResult`、`QualityReport` 及其传递依赖的
  工件契约类型从 `core/types.ts` 移入 `src/schema/contracts.ts`，schema validator 与 workflow
  生产者/消费者统一从该文件导入；不保留 schema 与 workflow 各自一份的双重类型真相；
- `.dependency-cruiser.cjs` 增加显式 `schema-not-to-workflow` 规则，并以
  `workflow → schema → workflow` 不成环作为 §7 架构验收的一部分。

| 现位置 | 目标位置 | 备注 |
|---|---|---|
| `src/core/` | `src/workflow/core/` | 例外：`hash.ts` 纯通用 → `src/utils/hash.ts` |
| `src/orchestration/` | `src/workflow/orchestration/` | 含 `dsl/` 子目录整体平移 |
| `src/driver/` | `src/workflow/driver/` | |
| `src/execution/` | `src/workflow/execution/` | |
| `src/report/` | `src/workflow/report/` | |
| `src/templates/` | `src/workflow/templates/` | `aws init` 脚手架模板，属 workflow 产品 |

## 3. eval executor 收编（原候选 A）

- `scripts/eval-workflow-run.mjs`（358 行）→ `src/eval/executors/workflow_run.ts`
- `scripts/eval-aws-run.mjs`（213 行）→ `src/eval/executors/aws_run.ts`
- `scripts/eval-seed-change.mjs`、`scripts/eval-archive-artifacts.mjs` 转 TS，
  成为 harness 内部步骤（内部接缝），不再是独立脚本
- `scripts/lib/` 全部转 TS 迁入 `src/eval/`：
  - `opencode-process-events.mjs`（764 行）+ 手写 `opencode-process-events.d.ts`
    合并为单个 TS 模块（含 harness 文件）
  - `write-scan.mjs`、`eval-wrapper-utils.mjs`、`eval-fixture-utils.mjs`、
    `fake-execution-evidence.mjs` 各自转 TS
- 7 个 suite YAML（`workflow-{case,api,e2e,fuzz,performance}-codegen`、`workflow-full`、
  `workflow-run`）：`executor.command: node .../scripts/eval-workflow-run.mjs ...`
  → `executor.type: workflow-run | aws-run` + 结构化参数
- `src/eval/types.ts` 与 `src/eval/schemas.ts` 增加下列判别联合；`mixed.per_check_type`
  接受任一 leaf executor，但禁止递归嵌套 `mixed`：

  ```ts
  interface ExecutorPolicyConfig {
    timeout_seconds: number;
    expected_outputs: string[];
    workdir?: string;
    sandbox?: { copy_from?: string; clean_before_run?: boolean };
    allowed_writes?: string[];
    env?: Record<string, string>;
  }

  interface WorkflowRunExecutorConfig extends ExecutorPolicyConfig {
    type: 'workflow-run';
    run_mode: string;
    test_type?: 'api' | 'e2e' | 'fuzz' | 'performance';
    run_tests?: boolean;
    entry?: 'driver' | 'orchestrator' | 'phase-skill';
    skip_seed?: boolean;
    opencode_bin?: string;
    aws_bin?: string;
    agent_cmd?: string;
  }

  interface AwsRunExecutorConfig extends ExecutorPolicyConfig {
    type: 'aws-run';
    skip_seed?: boolean;
    aws_bin?: string;
  }
  ```

  `repo_root`、`project_dir`、`change_id`、`fixture_tier`、`archive_dir`、`attempt_dir` 不再由
  suite 重复声明，由 harness 分别从 `workspace.root`、`sut.dir`、sample input 与 attempt
  context 注入；任一必需的注入值缺失时 fail closed。可选结构化参数缺失时沿用当前
  wrapper 默认值；`codegen-only` 继续强制恰好一个 `test_type`，Zod schema 对枚举、正数
  timeout 与必需输出进行 fail-closed 校验。
- `src/eval/executor.ts`：按 `config.type` 直接调用 TS executor，替换文件名正则
  `/eval-(aws-run|workflow-run)\.mjs\b/`；`workflow-run`、`aws-run` 被明确标记为
  external-evidence writer，harness 不覆盖它们写入的 `stdout.log`、`stderr.log`、
  `execution.json`。timeout、sandbox、env、allowed-writes、expected-output 收集以及
  `TOOL_EVENT` 落盘语义与原 subprocess 路径保持一致
- 同步更新：`eval/contracts/evidence-spec.md`、`eval/fixtures/README.md`

## 4. retro-nightly 收编（原候选 B）

- `src/retro/nightly/*.cjs`（7 文件 827 行）全部转 TS
- `scripts/retro-nightly.mjs`（548 行）拆为 `aws retro nightly <collect|resume|report>`
  子命令，挂进 `src/commands/retro.ts`，脚本删除
- `exec.cjs` 的 `resolveSkillsRoot` 依赖 `scripts/retro-nightly.mjs` 存在性定位仓库根，
  改为 `package.json` 锚点探测
- `tests/unit/retro-nightly/` 并入 `tests/unit/retro/`
- 同步更新：`eval/README.md`、`engineering/design/nightly-driver.md`

## 5. fake 脚本与 scripts/ 终态

- 4 个运行时测试替身保持 `.mjs` 形态迁到 `eval/fixtures/fakes/`：
  `fake-opencode-eval.mjs`、`fake-case-design-eval.mjs`、
  `fake-opencode-process-ndjson.mjs`、`fake-aws-workflow-echo.mjs`
  —— 引用方同步改：`.github/workflows/eval-smoke.yml`、`src/eval/_test/fake_case_design.ts`
- `scripts/` 终态只留 3 个文件：
  - `link-skills.sh`（npm script `link:skills` 挂载）
  - `create-ci-sut.mjs`（54 行，纯 CI 胶水）
  - `read-sut-pin.mjs`（31 行，纯 CI 胶水）

## 6. eval 数据目录整理

- 输出统一收进已 gitignore 的 `eval/out/{runs,batches,reports}`
- 迁移范围包含全部三个已跟踪的旧输出目录：`eval/runs/`（19 个历史 run、695 个文件）、
  `eval/batches/`（1 个历史 batch、6 个文件）与 `eval/reports/`（2 个文件）——
  **移除 Git 跟踪已经用户确认**
- 数据操作顺序固定为：先将三个目录内容移动到各自的 `eval/out/<kind>/`，核对迁移前后
  相对路径、文件数与 SHA-256 清单一致，再对旧路径执行 `git rm --cached`；
  `git rm --cached` 不能代替文件移动，也不能在校验完成前执行
- 迁移完成后，`git ls-files 'eval/runs/**' 'eval/batches/**' 'eval/reports/**'` 必须零输出，
  本地 `eval/out/{runs,batches,reports}` 中的迁移清单必须完整
- 配置保持 git 跟踪不动：`eval/baselines/`、`suites/`、`datasets/`、`judge/`、
  `contracts/`、`fixtures/`、`suts.yaml`
- 代码中所有指向 `eval/runs`、`eval/batches`、`eval/reports` 的路径常量
  （`src/eval/paths.ts` 等）
  同步指向 `eval/out/`

## 7. tests 与架构守护

- `tests/unit/` 目录随 src 重命名：`core|orchestration|driver|execution|report`
  → `workflow/` 下对应子目录；`retro-nightly/` → `retro/`
- `.dependency-cruiser.cjs` 从只查 `src/eval` 扩到整个 `src/`，新增规则：
  1. 禁止功能包（workflow / eval / retro / risk / schema / utils）之间循环依赖
     （workflow 包内部循环暂豁免）
  2. 禁止 schema 以 runtime 或 type-only import 依赖 workflow
  3. 禁止 `src/` 引用 `scripts/` 路径
- `npm run arch:check` 进 CI

## 8. 验收标准

1. `aws eval run` 全部 7 个 suite 的 verdict / metrics 与迁移前一致
   （fake OpenCode 路径 `EVAL_USE_FAKE_OPENCODE=1` 逐一对比）；同时逐 suite 对比
   `stdout.log`、`stderr.log`、`execution.json`、`tool-events.jsonl` 与 `raw-output/`
   清单，覆盖 timeout、失败退出、expected-output 缺失、sandbox/env/allowed-writes 行为
2. `.github/workflows/eval-smoke.yml` 通过
3. `src/eval/executor.ts` 无文件名正则；全仓 `rg` 对已删脚本路径零命中
4. `aws retro nightly` 三个子命令行为与旧入口 `scripts/retro-nightly.mjs` 对齐，
   `tests/unit/retro/` 全绿
5. 全量 jest + `tsc --noEmit` + depcruise（新规则）通过；depcruise 报告中
   `schema → workflow` 依赖与 `workflow ↔ schema` 包循环均为零
6. 三个旧 eval 输出目录均无 Git tracked file；迁移前后的相对路径、文件数和 SHA-256
   清单一致，`eval/out/{runs,batches,reports}` 均存在

Eval 基线、compiled run id、metrics 与 evidence inventory 对照固化在
[`2026-07-14-src-restructure-eval-parity.md`](../validation/2026-07-14-src-restructure-eval-parity.md)。

## 9. 风险与回滚

- **风险最高点**：§3 动 executor 契约 + 全部 workflow suite。回归以 fake OpenCode
  CI smoke 为锚，迁移前先跑一轮基线，留存 verdict / metrics、attempt evidence 与
  raw-output 清单快照供对比。
- **一把梭的代价**：中途不可部分合并；PR 系列内按 §2→§4→§3→§5→§6 顺序组织 commit，
  每个 commit 保持 `tsc --noEmit` + jest 绿，出问题可按 commit 粒度回退。
- 删除入口时同一 commit 内更新所有引用（skills/、.opencode/、docs/、CI yml），
  禁止留下指向已删路径的文档（验收 3 兜底）。
