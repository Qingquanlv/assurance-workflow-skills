# 目录结构收编候选清单（第 2 步）

> 背景：2026-07-13 架构评审 + 目录结构盘点。第 1 步（纯搬运）已完成：
> `scripts/lib/retro-nightly/` → `src/retro/nightly/`；顶级 `schemas/` → `docs/schemas/`
> 且 advisory 结构校验收敛到 `src/schema/advisory.ts`；eval 输出隔离到 `eval/out/{runs,batches,reports}`。
>
> 本清单的共同病根：**模块真身长在 `scripts/` 里**——以不编译、不受 `src` 测试覆盖的
> `.mjs`/`.cjs` 形式存在，产品（`src/`）反而要靠正则/路径字符串去识别它们。

---

## 候选 A — eval executor 收编

### 迁移前现状（现已完成）

- 两个 legacy eval `.mjs` 入口（workflow-run 359 行、aws-run 约 200 行）曾是
  eval harness 的真正 executor：编排 seed → write-scan → `aws workflow run` → write-scan
  → archive → evidence。
- 7 个 suite YAML（`workflow-{case,api,e2e,fuzz,performance}-codegen`、`workflow-full`、
  `workflow-run`）把它当 `executor.command` 硬编码为
  `node <legacy-workflow-run-entry> ...`。
- `src/eval/executor.ts` 靠正则 `/eval-(aws-run|workflow-run)\.mjs\b/` 识别
  「外部证据 executor」——接缝泄漏。
- 共享逻辑散在 `scripts/lib/`：`write-scan.mjs`、`eval-wrapper-utils.mjs`、
  `eval-fixture-utils.mjs`、`opencode-process-events.mjs`（+ 手写 `.d.ts`）。

### 目标终态

- 编排逻辑迁进 `src/eval/`（如 `src/eval/executors/workflow_run.ts`、`aws_run.ts`），
  走 TS + 编译 + 单测。
- suite YAML 用 `executor.type: workflow-run` 声明 + 结构化参数，不再指向裸脚本路径。
- `src/eval/executor.ts` 用类型分派，删除文件名正则。
- seed / archive / write-scan 成为 harness 内部步骤（内部接缝）；`scripts/` 只留可选的
  thin CLI 入口或直接删除。

### 涉及改动

`src/eval/executor.ts`、新建 executor 模块、7 个 suite YAML、`scripts/lib/*` 迁移、
`eval/contracts/evidence-spec.md`。

### 成本 / 风险

**高**。动 executor 契约 + 全部 workflow suite；CI smoke（fake OpenCode 路径，
`EVAL_USE_FAKE_OPENCODE=1`）必须逐一回归。

### 验收

- `aws eval run` 全 suite 与迁移前 verdict / metrics 一致。
- fake CI smoke（`.github/workflows/eval-smoke.yml`）通过。
- `src/eval/executor.ts` 无文件名正则。

---

## 候选 B — retro-nightly 入 `aws` 子命令

### 迁移前现状（现已完成）

第 1 步已把逻辑库挪进 `src/retro/nightly/*.cjs`，但只搬了位置、没改形态：

- legacy retro-nightly 入口（548 行）是未编译的 `.mjs`。
- 逻辑库 `src/retro/nightly/*.cjs`（7 文件 827 行，`.cjs` 不走 `tsc`）。
- 横跨「脚本入口 + 非编译 cjs 库」两种形态，与 `src/commands/` 的产品模式不统一。

### 目标终态

- 做成 `aws retro nightly <collect|resume|report>` 子命令：`.cjs` 逻辑逐步转 TS，
  挂进 `src/commands/retro.ts`，进 `dist/cli.js`。
- legacy retro-nightly 入口退化为几行 wrapper 或删除。
- 依据：`boundary-inventory.md` 将 retro 归为要保留的「评估环路」，收进产品内核方向正确。

### 涉及改动

`src/retro/nightly/*.cjs` → TS、`src/commands/retro.ts`、`src/cli.ts`、
`tests/unit/retro-nightly/*`、`README-EVAL.md`、`docs/design/nightly-driver.md`。

### 成本 / 风险

**中**。`.cjs` → TS 有类型收敛成本；`exec.cjs` 的 `resolveSkillsRoot` 依赖
legacy retro-nightly 入口存在做仓库根定位，需更换探测锚点。

### 验收

- `aws retro nightly` 三子命令行为对齐旧入口。
- lib 单测（`tests/unit/retro-nightly/`）通过。
- 全仓无对已删脚本路径的引用（`rg` 零命中）。

---

## 关联项 — 候选 C：`core/` 拆分（押后）

原顶级 workflow core 目录（4,752 行，16 文件）混住了 workflow 内核（`workflow_state`、`healing_state`、
`events`、`audit`）与通用工具（`hash`、`case_id`、`generator`、`checks`）。

**押后到 Workflow Progression 深化（`inspect/advance/resume` 接口收窄 + healing 内化）
定型之后再做**，否则模块边界未定，会搬两次。

---

## 排序与依赖

| 顺序 | 候选 | 理由 |
|---|---|---|
| 先 | B（retro-nightly） | 独立、风险中等；第 1 步已把库挪到位，顺势收编成本最低 |
| 后 | A（eval executor） | 风险最高，动全部 suite；与 progression 无耦合，可任意时机做但要留足回归时间 |
| 最后 | C（core 拆分） | 依赖 progression 定型，过早做会返工 |

与 progression 深化（架构评审候选 1）的关系：A/B/C 均为**目录/形态**层面收编，
与 `inspect/advance/resume` 的**接口深化**正交，可并行推进、互不阻塞。
