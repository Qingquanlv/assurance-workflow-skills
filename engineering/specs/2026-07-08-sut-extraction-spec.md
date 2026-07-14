# SUT 外置迁移 Spec：bench 抽独立仓 + SUT 注册表 + 分支收敛

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

**日期**: 2026-07-08
**版本**: v0.1（Draft / Proposal，实现-ready）
**状态**: Implemented (2026-07-08)
**涉及面（规划）**: `bench/`（移出）、`eval/suts.yaml`（新增）、`eval/datasets/**/*.yaml`（40 个样本）、`eval/suites/*.yaml`（7 个 suite）、`src/eval/executor_template.ts`、`src/eval/runner.ts`、`scripts/eval-workflow-run.mjs` / `eval-seed-change.mjs`（不改，仅确认参数化）、`.github/workflows/eval-smoke.yml` / `eval-full.yml`、`.gitignore`、`README-EVAL.md`
**关联设计**:
- [2026-07-08-meta-team-retro-loop-spec.md](2026-07-08-meta-team-retro-loop-spec.md)（retro/演化闭环依赖 eval 作为 fitness 函数——本 spec 的仓库拓扑决策服务于该闭环）
- `README-EVAL.md`（fixture tier 模型与 bench seed 机制）

---

## 0. 决策与依据

### 0.1 目标拓扑（两仓，非三仓）

```text
仓库 1  assurance-workflow-skills（主仓，收敛回单主线）
        产品 CLI + skills + eval harness（src/eval + eval/，含 golden fixtures）
仓库 2  aws-bench-fastapi-vue-admin（SUT 仓）
        bench/fastapi-vue-admin 全量迁移（含其 .aws/ 种子配置、opencode.json）
```

**硬约束**（用户明确）：主分支不得包含被测系统（SUT）代码。

**为什么评测集不拆出去**（否决"三仓"与"仅拆评测集"）：

1. eval 是演化闭环的 **fitness 函数**——retro 提案、schema 变体落地前都要跑 eval 回归；改 skill 输出契约与更新对应 golden/scorer 必须在**同一个 PR 原子提交**，跨仓必然产生版本错位窗口。
2. 依赖方向决定：`src/eval` import 产品**内部模块**（`report/failure_classifier` 的 `classifyFailure`、`execution/manifest_parser`、`core/types`），非公开 API。拆出去要么稳定化内部 API（大工程）要么 pin SHA（脆弱）。
3. 学界同构：AFlow 的 Optimizer/Evaluator 同循环、EvoMAS 的配置池/评测同迭代——**演化器与 fitness 函数同仓共进化；benchmark 数据集外置 pin 版本**（EvoMAS 的 `EVOMAS_REPOS_DIR` 即外部 clone 的 SWE-bench 目录）。SUT 在此结构里是"数据集"，不是"系统"。

### 0.2 耦合审计结论（2026-07-08 实测）

| 区域 | bench 引用 | 性质 |
|---|---|---|
| `src/`（产品） | **0**（仅 `src/eval` 2 处注释） | 无耦合 |
| `scripts/eval-*.mjs` | 0 硬编码（全部经 `--project-dir` 传参） | 已参数化 |
| `tests/` `skills/` `docs/` `package.json` | 0 | 无耦合 |
| `eval/datasets/**` | 40 个样本 YAML 各一行 `project_dir: bench/fastapi-vue-admin` | 纯数据 |
| `eval/suites/*.yaml` | `--project-dir {{workspace.root}}/{{sample.input.project_dir}}` | 前缀假设 SUT 在仓内（唯一焊点） |
| `eval/contracts` + `fixtures` | 6 处文档/注释提及 | 文案 |
| CI 2 个 workflow | 路径触发器 + `test -f bench/...` + bench 内 `git init` | 换外部 checkout |
| **反向**（bench → 主仓） | 仅 `bench/.../opencode.json` 硬编码本机绝对路径 | 本就是坏味道，随迁移清除 |

**结论：可拆。唯一真正的代码级焊点是 suite 模板的 `{{workspace.root}}/` 前缀。**

### 0.3 方案一句话

> `bench/` 迁出为独立 SUT 仓；主仓新增 `eval/suts.yaml` 注册表（repo + **pinned SHA** + 本地路径）；dataset 样本从 `project_dir: <路径>` 改为 `sut: <逻辑名>`；模板引擎新增 `{{sut.dir}}` 变量由注册表解析；CI 用第二 checkout 拉 SUT 仓；随后 main/eval 双分支收敛为单主线。

**验收总标准**：主分支 `git ls-tree` 无任何 SUT 代码；`EVAL_USE_FAKE_OPENCODE=1` 的 E0/E2a smoke 与 E3 WR-001 在"SUT 位于外部 checkout"布局下全绿；SUT checkout SHA 与 `suts.yaml` pin 不符时 runner 明确警告；main 与 eval 分支合并归一。

---

## 1. 机制 A：SUT 注册表（`eval/suts.yaml`）

```yaml
# eval/suts.yaml — SUT registry. Golden fixtures are version-bound to pinned_sha.
suts:
  fastapi-vue-admin:
    repo: git@github.com:Qingquanlv/aws-bench-fastapi-vue-admin.git
    pinned_sha: "<迁移时填写>"
    # 解析顺序：$EVAL_SUT_DIR（若设置，指向该 SUT checkout）
    #        → local_dir（相对主仓根）
    local_dir: "../aws-bench-fastapi-vue-admin"
```

解析规则（fail-fast）：

1. `EVAL_SUT_DIR` 环境变量优先（CI 与多 checkout 场景）；
2. 否则取 `local_dir`（相对 `workspace.root` 解析为绝对路径）;
3. 目录不存在 → **报错**并打印 `git clone <repo> <local_dir>` 提示（不自动 clone，保持 runner 无网络副作用）；
4. checkout HEAD SHA ≠ `pinned_sha` → **警告**（不阻断：本地开发允许领先，但输出必须醒目，因为 golden 与 SUT 版本强绑定）。

> **pin 纪律**：golden fixture（`eval/fixtures/samples/*`）记录的是该 SUT 特定版本的行为（如 depts ORM `max_length=20`、ANOMALY-002 菜单循环引用、ANOMALY-003 重复名 500）。**升级 SUT 仓 = 在主仓同一 PR 内更新 `pinned_sha` + 受影响 golden**。

## 2. 机制 B：模板与数据改造

### 2.1 `src/eval/executor_template.ts`

`expandTemplateVars()` 新增变量：

```ts
// input 增加 sutDir?: string（由 runner 按机制 A 解析后传入）
if (sutDir) vars['sut.dir'] = sutDir;
```

`src/eval/runner.ts` 在构造 vars 前：读样本 `input.sut` → 加载 `eval/suts.yaml` → 按机制 A 解析出 `sutDir`。样本无 `sut` 字段则不注入（向后兼容非 workflow suite，如 classification-unit / safety-lite）。

### 2.2 dataset 样本（40 个，机械替换）

```yaml
# before
input:
  project_dir: bench/fastapi-vue-admin
# after
input:
  sut: fastapi-vue-admin
```

### 2.3 suite 模板（7 个 workflow suite）

```yaml
# before
--project-dir {{workspace.root}}/{{sample.input.project_dir}}
# after
--project-dir {{sut.dir}}
```

`scripts/eval-workflow-run.mjs` / `eval-seed-change.mjs` / `eval-aws-run.mjs` **零改动**——它们本就接收绝对 `--project-dir`。

### 2.4 契约文档与 fixture 注释

`eval/contracts/{metric-spec,evidence-spec}.md`、`eval/fixtures/README.md` 中 `bench/fastapi-vue-admin/...` 路径表述改为 `<sut.dir>/...`；语义不变。

## 3. 机制 C：SUT 仓迁移

1. 新建仓 `aws-bench-fastapi-vue-admin`；用 `git filter-repo --path bench/fastapi-vue-admin/ --path-rename bench/fastapi-vue-admin/:` 保留历史（或接受快照迁移，一次 commit）;
2. 迁移后 SUT 仓内清理反向耦合：`opencode.json` 删除本机绝对路径 `skills.paths` 条目（保留 plugin git 引用即可）；`AGENTS.md` 中指向旧本机路径的 skill 表格改为 plugin 说明；
3. 主仓 `git rm -r bench/`；`.gitignore` 追加 `../aws-bench-fastapi-vue-admin`（若团队约定放同级目录则无需，仅当选择仓内 `sut-checkouts/` 布局时加）；
4. 记录 SUT 仓初始 SHA → 填入 `suts.yaml.pinned_sha`。

## 4. 机制 D：CI 改造（`.github/workflows/eval-smoke.yml`、`eval-full.yml`）

```yaml
steps:
  - uses: actions/checkout@v4                    # 主仓
  - uses: actions/checkout@v4                    # SUT 仓
    with:
      repository: Qingquanlv/aws-bench-fastapi-vue-admin
      ref: <pinned_sha>        # 与 suts.yaml 一致；可由脚本从 suts.yaml 读出
      path: sut/fastapi-vue-admin
  - name: Point eval at SUT checkout
    run: echo "EVAL_SUT_DIR=$GITHUB_WORKSPACE/sut/fastapi-vue-admin" >> $GITHUB_ENV
```

- 原 `Verify bench opencode.json exists` / `Init bench git repo`（write-scan 需要 git 边界）步骤保留，路径改 `$EVAL_SUT_DIR`；
- 触发器中 `bench/fastapi-vue-admin/**` 路径条目删除（SUT 变更不再触发主仓 CI；SUT 升级经 `suts.yaml` PR 触发）。

## 5. 机制 E：分支收敛（迁移完成后）

SUT 移出后，main 与 eval 分支的差异只剩 eval harness 本身，而 harness 按 §0.1 决策**回归主线**：

1. 在 eval 分支完成机制 A–D（此时 eval 分支已无 `bench/`）;
2. `main` ← merge `eval`（此后 harness 在 main 上）;
3. 归档/删除 `eval` 长期分支；后续 eval 相关改动直接走 main 的 feature branch + PR;
4. npm 发布纯净性由 `package.json` `files` 白名单保证（`dist`、`skills`、`schemas`、`.opencode` 等），非分支隔离。

> 这一步消除的成本：main 每次演进都要向 eval 手工合并（上次 600+ 文件 modify/delete 冲突）。

---

## 6. 实施顺序与估时（合计约 1 天）

| 步 | 内容 | 验证 |
|---|---|---|
| ① | 建 SUT 仓 + 迁移 + 清理反向耦合 + 记录 SHA | SUT 仓可独立 `docker compose up` / `run.py` 起服务 |
| ② | `suts.yaml` + `executor_template.ts`/`runner.ts` 解析（含缺目录报错、SHA 警告） | 单测：注册表解析三分支（env 覆盖 / local_dir / 缺失报错） |
| ③ | 40 个 dataset + 7 个 suite + 契约文档批量替换 | `EVAL_USE_FAKE_OPENCODE=1` 跑 WC-001、WAC-001 全绿 |
| ④ | 主仓 `git rm -r bench/` + CI 双 checkout | CI smoke 绿；E3 WR-001 本地绿 |
| ⑤ | 分支收敛（main ← eval，删 eval 分支） | `git ls-tree origin/main` 无 SUT；单主线 |

## 7. 非目标（明确排除）

- **不拆评测集**：`src/eval` + `eval/` 永久留主仓（§0.1 依据）。
- **不自动 clone SUT**：runner 只解析与校验，clone 是显式人工/CI 步骤。
- **不做多 SUT 泛化实现**：`suts.yaml` 结构天然支持多 SUT，但本次只迁移 fastapi-vue-admin 一个；第二 SUT 属后续工作。
- **不改 fixture tier 机制**：`eval-seed-change.mjs` 的 seed 语义（拷入 `<sut>/qa/changes/` 与 `<sut>/tests/`）不变，仅目标根目录来源变化。
