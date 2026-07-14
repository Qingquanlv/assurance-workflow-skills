# Repo Structure Cleanup: schemas 提取 + 工程资料归位 + 根目录清理

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

Status: implemented / complete (2026-07-14)

Scope: repository layout, content authority, reference migration, and release verification

## Problem Statement

仓库的机器契约、设计文档、工作笔记混在同一棵 `docs/` 树下，根目录还散落着未归位的杂项：

1. **运行时 schema 曾藏在文档目录里。** 现 `schemas/workflow-schema.yaml` 是 orchestration 引擎运行时加载的 SSOT；迁移前它位于 `docs` 的 design 子树，供 agent/人对照的 JSON Schema 契约也位于 `docs` 的 schemas 子树。它们和纯说明性文档混放，导致 `.gitignore` 需要逐文件白名单维护跟踪状态，schema 一度有被 ignore 的风险。
2. **docs 混入了非用户文档。** 迁移前 `docs` 的 design 子树同时装着运行时 schema、内部设计文档和本地工作草稿，工具计划、spec 和 validation 也位于 `docs`。这些内容不是用户理解和使用项目所需的文档，却与面向用户的文档共享同一棵目录树，模糊了内容权威与生命周期。
3. **根目录杂项。** 面向用户的 Eval 指南以根目录杂项形式存在，且 `eval/`
   缺少一个只说明实现与数据布局的本地索引。

参照 OpenSpec 的布局（顶层 `schemas/` 放机器读取的 schema 与模板、`docs/` 只放面向用户的文档、`scripts/` 只放维护/CI 脚本），本仓库需要一次结构收敛。`docs/` 是用户可观察行为、配置和命令语义的唯一文档真源；内部设计与工程过程资料必须移出。`scripts/` 现状（`link-skills.sh`、`create-ci-sut.mjs`、`read-sut-pin.mjs`）已符合“只放维护/CI 脚本”，不在本次改动范围。

## Solution

三个独立可交付的迁移，按 tracer-bullet 顺序执行：

### A. 顶层 `schemas/`：机器契约单独提出

新建顶层 `schemas/`，收拢所有被代码或 agent 按路径读取的 schema 文件：

```
schemas/
  workflow-schema.yaml          # ← 原 docs design 子树（运行时 SSOT）
  explore-advisory.schema.json  # ← 原 docs schemas 子树
  explore-context.schema.json   # ← 原 docs schemas 子树
  README.md                     # package index；人类说明见 docs/schemas.md
```

不迁移的：

- `src/schema/*.ts`（zod 运行时校验，是代码不是配置，留在 `src/`）
- `eval/contracts/*`（eval 自成一体的数据+契约目录，保持内聚）

### B. docs 只放用户文档：工程资料迁入 `engineering/`

新增顶层 `engineering/`，集中存放需要版本控制、供维护者长期查阅的工程知识：

```
engineering/
  README.md     # 目录职责、内容权威与生命周期规则
  design/       # ← 原 docs design 子树的 Markdown（全部设计文档）
  plans/        # ← 原 docs 工具计划
  specs/        # ← 原 docs 工具 specs
  validation/   # ← 原 docs 工具 validation
  notes/        # ← 原 docs 工具散件
```

`.superpowers/` 只承载 `sdd/`、`brainstorm/`、`qa-dashboard/` 等工具运行状态和一次性产物，整体不跟踪。稳定工程知识不得写入该目录。

迁移后 `docs/` 只保留面向用户或贡献者的正式文档，包括 `docs/agents/`（AGENTS.md 引用的规则文档）。项目约定要求未来 ADR 仍写入 `docs/adr/`；ADR 只记录决策及其理由，不得成为用户行为规范的第二真源。内容权威规则如下：

- `docs/` 是用户可观察行为、配置、命令和操作流程的唯一文档真源。
- `engineering/` 只描述实现设计、决策背景、实施计划和验证证据；涉及用户行为时必须链接到 `docs/`，不得复制一份规范性描述。
- `schemas/` 是机器读取契约的真源；对应的人类说明放在 `docs/` 并链接到 schema，不复制机器约束。
- `.superpowers/` 是可再生成或一次性的本地状态，不作为任何稳定知识的真源。

### C. 根目录与 .gitignore 清理

- 原根目录 Eval README 的完整内容 → `docs/eval.md`（保留文件历史并作为唯一用户
  权威）；新建精简的 `eval/README.md`，仅作明确非规范性的实现/数据目录索引并链接
  回权威文档；根 README 补一行指引。
- `.gitignore` 移除旧 design 文档树的逐文件规则和旧工具资料树规则；保留现有 `.superpowers/` 整体忽略规则，不为其增加白名单。`engineering/` 与 `schemas/` 正常跟踪。

## Implementation Decisions

- **`findSchemaFile` 查找顺序**（`src/workflow/orchestration/schema.ts`）更新为：显式 override → 项目 `.aws/workflow-schema.yaml` → 项目 `schemas/workflow-schema.yaml` → 项目旧文档树的 workflow schema（**兼容旧 SUT 项目，标记 deprecated**）→ 包内 `schemas/workflow-schema.yaml`。包内旧路径不再保留。
- 同步更新 docstring（264–265 行写死了旧路径）与 `src/schema/advisory.ts` 头注释里的旧 docs schema 引用。
- **全仓引用改写**：扫描所有活跃文件中的旧 design、工具资料、schema 文档路径和旧版 Eval README 引用并更新，覆盖 `src/**`、`tests/**`、`eval/**`、`skills/**`、`.opencode/**`、`README.md`、`AGENTS.md` 与现存正式文档。**历史产物不改写**（`eval/runs/`、`eval/out/`、CHANGELOG、已归档 review diff）。
- 原根 Eval 指南按完整内容迁入 `docs/eval.md`，不摘要或重写；`eval/README.md`
  是迁移后新建的非规范性目录索引，不承接原指南的文档权威。
- 设计文档内部互引（如 `boundary-inventory.md` ↔ `workflow-driver.md`）随迁移改为 `engineering/design/` 相对路径；其他活跃调用方按实际目标改为 `engineering/**`。
- 新增 `engineering/README.md`，固化本 spec 的内容权威规则，并给出 design、plans、specs、validation、notes 的准入条件和生命周期；迁移后的各子目录不得各自发明另一套分类规则。
- 迁移前分别生成旧 design 与工具资料树的“已跟踪/未跟踪”清单并检查目标路径冲突。已跟踪文件用 `git mv` 保留历史。未跟踪文件不得删除或静默纳入提交：明确属于稳定工程资料的文件迁入 `engineering/` 并列入提交清单；无法确认的本地草稿移入仍被忽略的 `.superpowers/migration-backup/`，在实施报告中列出原路径和备份路径。
- `.superpowers/` 中已被意外跟踪的一次性文件执行 `git rm --cached`，文件留在工作区并由整体 ignore 规则接管；已确认属于稳定工程知识的内容必须先迁入 `engineering/`。
- 迁移拆成三个独立 commit（A schemas、B docs、C 根目录/gitignore），每个 commit 自身通过 lint + 测试，可单独 revert。
- 不引入新的抽象或配置项；`findSchemaFile` 之外的代码不感知本次路径变化。

## Testing Decisions

- 每个 commit 后运行 `npm run lint`（tsc --noEmit + depcruise）与 `npm test` 全量。
- **schema 定位冒烟**：临时目录模拟无 `.aws/workflow-schema.yaml`、无项目 schema 的 SUT，断言 `findSchemaFile` 回退到包内 `schemas/workflow-schema.yaml`；再模拟带旧文档树 schema 的存量项目，断言 deprecated 回退仍生效。
- 更新 `findSchemaFile` 相关既有单测的路径夹具；`deleted_reference_scan` / `registry_consistency` 等按新路径断言。
- **发布包验证**：先从编译后的 `dist` 执行 schema 定位冒烟，再运行 `npm pack --dry-run`（或检查实际 tarball 清单），断言发布包包含 `schemas/workflow-schema.yaml` 以及其余顶层 schema、完整的 `docs/eval.md` 和非规范性的 `eval/README.md` 索引，且不依赖仓库内的旧路径。
- **删除引用扫描**：活跃文件中的旧 design、工具资料、schema 文档路径和旧版 Eval README 文件名必须零命中；唯一例外是 `findSchemaFile` 中用于旧 SUT 兼容的旧 schema 字面量及直接验证该兼容分支的测试。扫描使用明确的目录排除列表（`eval/runs/`、`eval/out/`、`.superpowers/`、CHANGELOG），不得用宽泛规则掩盖其他活跃引用。
- 收尾验证：确认 `docs/` 中不存在内部设计、计划、spec、validation 或本地工作笔记；`git status` 不含意外未跟踪文件；`aws status --change <现有 change>` 在本仓库内可正常运行。

## Out of Scope

- `scripts/` 调整（现状已符合目标定位）。
- `eval/contracts` 迁移、`src/schema` 迁移。
- `banchmark/` 目录（未跟踪的本地 SUT，保持现状不处理）。
- 历史 eval 产物、归档 diff 的路径改写。
- `docs/adr/` 的建立（AGENTS.md 已有约定，等首个 ADR 出现时再建目录）。

## Migration Order

1. **A: schemas 提取** — git mv schema 文件 → 改 `findSchemaFile` + 注释 → 改测试与活跃引用 → lint/test 绿。
2. **B: 工程资料迁移** — 盘点 tracked/untracked 文件 → git mv 稳定 design/superpowers 文档到 `engineering/` → 安全备份未确认草稿 → 更新全部活跃引用 → lint/test 绿。
3. **C: 根目录清理** — 原根 Eval 指南完整迁入 `docs/eval.md`、新建非规范性
   `eval/README.md` 目录索引、更新全部引用、.gitignore 收敛、`.superpowers/`
   一次性文件去跟踪 → 发布包与收尾 rg/status 验证。

## Implementation outcome

The cleanup was delivered as the planned three independently revertible phase
commits:

1. `4e2e6ca` — `refactor(repo): move runtime schemas to top level`
2. `bbe0760` — `refactor(repo): move engineering docs out of docs`
3. This phase-C commit — `chore(repo): finish repository structure cleanup`

The resulting repository keeps machine contracts in `schemas/`, current
user-facing guidance in `docs/` (including the complete former root Eval guide
as canonical `docs/eval.md`), stable and explicitly historical maintainer
knowledge in `engineering/`, eval implementation/data under `eval/` with a new
non-normative `eval/README.md` index, and regenerable one-off tool state under
ignored `.superpowers/`.
