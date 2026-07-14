# Healing 证据完整性 Spec：产品树 hash 守卫 + override 留证 + safety 证据 CLI 化 + assertion 拆分

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

**日期**: 2026-07-06
**版本**: v1.0
**状态**: Implemented（2026-07-06）
**涉及面**: `src/core/hash.ts`、`src/core/healing_state.ts`、`src/core/events.ts`、`src/core/audit.ts`、`src/core/gate_override.ts`、`src/commands/run.ts`、`src/execution/runner.ts`、`src/report/inspector.ts`、`src/report/failure_classifier.ts`、`src/report/report_generator.ts`、`src/templates/execution-policy.ts`、`schemas/workflow-schema.yaml`、`skills/aws-{run,execute,workflow,inspect,fix-proposal}/SKILL.md`
**关联设计**:
- [engineering/design/state-machine-enforcement.md](../design/state-machine-enforcement.md)（gate 产物防篡改 + healing 状态机架构）
- [2026-07-04-run-integrity-tests-hash-guard.md](2026-07-04-run-integrity-tests-hash-guard.md)（前序 spec；本 spec 是其对称补全——tests 树有 hash 守卫了，产品树、override 证据、safety 证据还没有）

---

## 0. 问题与方案映射

### 0.1 实测事故 / 缺口（RET-user-management，2026-07-06；vue-fastapi-admin 项目）

四个缺口在同一次 change 中全部暴露：

| # | 缺口 | 实测证据 |
|---|---|---|
| A | **产品代码无 hash 守卫**。`tests/` 有 tree hash 机械强制，`app/`/`web/` 只靠 agent 自写的 safety-check JSON 自证 | `aws run` 不记录、不校验产品树 hash；RET-api-management 的 `inspect-safety-check.json` 为 agent 手写，`passed: true` 无任何机器校验 |
| B | **`--allow-test-changes` 旁路只留一行 reason**。healing 正路有三层证据（fix-proposal → apply-summary → fixer-safety-check），旁路只有 `human_override` 事件一条 | events.jsonl seq 24：仅 `reason` + 新树总 hash；变更文件清单、逐文件新旧 hash、diff 全部缺失。且 CLI 在**拒绝时**已算出 `changedFiles`，**放行时**却丢弃（见 §0.2） |
| C | **safety 证据不受防篡改审计**。`reads_sha256` 记录与 audit 校验都硬编码只认 `review/*.json`；且 safety-check 内容本身是 agent 自报的 | `src/core/events.ts` `computeReadsSha256` 与 `src/core/audit.ts` `auditGateTampering` 双重 `review/` 过滤；CLI 全源码对 `inspect-safety-check.json` 引用为 **0** |
| D | **`assertion_failure` 一刀切不可修，自愈覆盖率低**。LLM codegen 最常见错误恰是期望值写错，被归入 `assertion_failure` 后 healing 判 `not_needed`，实践中人工旁路（B）反而比 healing 更常用 | RET-user-management：真正该走 healing 的失败（邮箱域名、定位器）发生在第一轮被人工旁路修掉；终局 2 个失败全是 `assertion_failure`，healing 全程未触发 |

### 0.2 关键源码事实（实现时直接对号）

1. **B 的核心数据已在内存中被丢弃**——`src/commands/run.ts` override 分支拿到的 `integrity: TestTreeIntegrityResult` 已含 `changedFiles`（`healing_state.ts` `diffTestFiles()` 产出），且旧 batch manifest 有 `test_files_sha256`、`integrity.current.files` 有新 hash，但事件只写了 `review_sha256: integrity.current.aggregate`。
2. **C 的过滤器有两处**，必须同步改：`events.ts` `computeReadsSha256`（记录侧）与 `audit.ts` `auditGateTampering`（校验侧）；另外 `gate_override.ts` 第 31 行绑定 override 证据同样只认 `review/*.json`。
3. **verdict 迁移审计会误伤 healing 重检**：`audit.ts` `checkVerdictMigration` 对 `pass→pass` 且内容变化只认 repair phase 放行，而 healing-reinspect 后 safety gate 合法重写证据文件，inspect 无 `repair_of` phase → 直接套用会误报 `GATE-TRANSITION-ILLEGAL`（见 §3.3 豁免规则）。
4. **schema 分歧**：包内规范 schema（`schemas/workflow-schema.yaml`）只有 `fixer-safety-gate`；`inspect-safety-gate` + `inspect/inspect-safety-check.json` 只存在于部分项目本地 `.aws/workflow-schema.yaml` 副本。本 spec 以 `fixer-safety-check.json` 为规范对象；`inspect-safety-check` 的上游标准化进 backlog（§8）。
5. **D 可复用现成机制**：`failure_classifier.ts` 的 `FIX_PROPOSAL_ALLOWED` 已支持 `'review'` 值（`fuzz_stateful_failure`、`perf_threshold_exceeded` 在用）→ `needsReview: true`。
6. 基础设施现成：`hash.ts` `hashTestTree`（aggregate + 逐文件）可直接派生 `hashProductTree`；`risk/git_diff.ts` 已有 `spawnSync('git', …)` 封装。

### 0.3 方案一句话

> **A**：`aws run` 每 batch 记录产品树 hash，healing 重跑时不一致 → 硬拒绝；**B**：override 放行时把已算出的变更清单 + git diff 落盘为 `test-changes-override.json`，报告必须呈现；**C**：safety/apply-summary 证据纳入 `reads_sha256` 记录与 tamper 审计（允许清单常量三处共享），且 `fixer-safety-check.json` 改为 CLI 现算而非 agent 自报；**D**：新增 `assertion_expectation_error` 子类走 `'review'` 半自动通道，重分类必须经 CLI 命令留事件。

**验收总标准**：healing 期间改动 `app/**` 会被 CLI 机械拦截；任何 `execution.test-changes` 决策都能在报告中看到改了哪些文件、diff 是什么；safety 证据在 gate 裁决后被篡改会在下一次 `aws status` 标记 tampered；期望值写错类失败有一条经人工确认的半自动修复通道。

---

## 1. 机制 A：产品代码树 hash 守卫（对应讨论中的方案 1）

### 1.1 `hashProductTree`（`src/core/hash.ts`）

```ts
export function hashProductTree(projectRoot: string, roots: string[]): TestTreeHash
```

- 复用 `TestTreeHash` 结构（aggregate + files）与 `hashTestTree` 的排除规则（隐藏文件、`__pycache__`、`*.pyc`），追加排除：`node_modules/`、`dist/`、`build/`、`.venv/`、`*.map`
- `roots` 来自 `.aws/config.yaml` 新增字段（`aws init` 模板同步）：

```yaml
execution:
  product_code_roots: [app, web/src, src]   # 不存在的目录静默跳过
```

### 1.2 Manifest 写入（`src/execution/runner.ts`）

- `execution-manifest.yaml`（及 batch 副本）新增 `product_tree_sha256: <aggregate>`
- 逐文件映射**不进 manifest**（产品树文件数可能上千），写入 `execution/runs/<batch>/product-files-sha256.json`

### 1.3 守卫逻辑（`src/core/healing_state.ts` 新增 `assertProductTreeUnchangedInHealing`）

```text
读上一 batch manifest：
  无 product_tree_sha256（旧产物）→ 放行（fail-open 一次，本次起记录）

计算当前 hashProductTree：
  一致 → 放行
  不一致：
    isHealingRunContext == true（healing 重跑）→ throw PRODUCT-CHANGED-DURING-HEALING（无旁路 flag）
    非 healing 重跑（如开发者修了产品 bug 后正常重测）→ 放行 + 追加
      { source:'run', type:'product_tree_changed', prev_sha256, new_sha256 } 事件，
      基线随本 batch 重置；aws status 以 info 级列出（不置 stopped）
```

**错误文案（教正路）**：

```text
PRODUCT-CHANGED-DURING-HEALING: product code (roots: app, web/src) changed during the healing
loop (baseline batch <batch_id>). Healing MUST NOT touch product code. Revert product changes,
or abandon healing (aws state heal --to failed) and start a new formal run.
```

- 硬拒绝**不提供任何旁路 flag**——healing 语境下改产品代码没有合法场景
- 该 hash 同时是 §3.2 CLI 版 fixer-safety-check 中 `product_code_modified` 的判定来源（从"信 agent"变为一行比对）

---

## 2. 机制 B：测试变更决策留证（对应讨论中的方案 3）

### 2.1 证据文件（`src/commands/run.ts` override 分支，数据全部现成）

放行时写 `execution/runs/<batch>/test-changes-override.json`：

```jsonc
{
  "schema_version": "1.0",
  "change_id": "<id>",
  "batch_id": "<本次 batch>",
  "baseline_batch_id": "<integrity.previousBatchId>",
  "reason": "<--reason 原文>",
  "created_at": "<ISO8601>",
  "changed_files": [
    { "path": "tests/api/test_user_api.py",
      "old_sha256": "<旧 manifest test_files_sha256>",  // 新增文件为 null
      "new_sha256": "<integrity.current.files>",        // 删除文件为 null
      "change_type": "modified|added|deleted" }
  ],
  "git_diff_file": "test-changes-override.diff"          // 不可用时为 null
}
```

- `changed_files` 由 `TestTreeIntegrityResult` 扩展承载：`changedFiles: string[]` 升级为 `changedFiles: ChangedTestFile[]`（path + old/new sha256 + change_type），`diffTestFiles` 相应返回结构体（**破坏性内部改动**，调用方仅 `run.ts` 报错文案一处，取 `.path` 即可）
- diff 正文：复用 `risk/git_diff.ts` 的 `runGit` 跑 `git diff -- tests/` 存伴生 `.diff`。**哈希清单是权威证据，diff 是 best-effort 附件**——两次 run 之间若发生过 commit，工作区 diff 可能为空或不完整；非 git 项目跳过并置 `git_diff_file: null`

### 2.2 事件增强（`src/core/events.ts`）

`HumanOverrideEvent`（`action == allow_test_changes`）新增可选字段：

```jsonc
{ "evidence_file": "execution/runs/<batch>/test-changes-override.json",
  "evidence_sha256": "<该文件写入后的 sha256>",
  "changed_files_count": 3 }
```

`evidence_sha256` 使证据文件接入 §3.1 的 tamper 审计（audit 侧新增：对含 `evidence_sha256` 的 `human_override` 事件重算文件 hash，不一致 → `ARTIFACT-TAMPERED`）。

### 2.3 报告与归档呈现（`src/report/report_generator.ts`）

- 质量报告新增 "Human Overrides" 小节：每条 `allow_test_changes` 事件列 reason、时间、文件数、证据文件路径；**0 条时不渲染**
- 现状对照：RET-user-management 报告 91 分，完全看不出 3 个测试文件被人工改过——报告必须让 reviewer 一眼看到旁路痕迹

### 2.4 策略分级（`src/templates/execution-policy.ts`）

```jsonc
"healing": {
  // ...现有字段...
  "testChangesOverride": "with-evidence"   // forbidden | with-evidence | free
}
```

| 值 | 行为 |
|---|---|
| `forbidden` | 测试变更决策在执行时被拒绝（CI tier 默认） |
| `with-evidence` | 现行为 + §2.1 证据文件强制生成（local tier 新默认） |
| `free` | 现行为（仅事件，无证据文件）——留给不装 git 且不要审计的场景，显式配置才可用 |

---

## 3. 机制 C：safety 证据纳入防篡改 + CLI 化（对应讨论中的方案 4）

### 3.1 第 1 层：tamper 审计扩围（`events.ts` + `audit.ts` + `gate_override.ts`）

新增共享常量（建议放 `src/core/audit_scope.ts`，三处引用，防漂移）：

```ts
export const AUDITED_GATE_READS: RegExp[] = [
  /^review\/[^/]+\.json$/,
  /^healing\/fixer-safety-check\.json$/,
  /^healing\/(api|e2e)-apply-summary\.json$/,
  /^inspect\/inspect-safety-check\.json$/,   // 项目本地 schema 扩展也受保护
];
```

- `events.ts` `computeReadsSha256`：`review/` 前缀判断 → 匹配 `AUDITED_GATE_READS`
- `audit.ts` `auditGateTampering`：同上
- `gate_override.ts`：override 绑定的 reads 查找同步放宽（safety gate 的 `needs_human_review` 也能绑定证据）
- **向后兼容**：audit 只校验事件中**已记录**的哈希；旧 change 的事件里没有 safety-check 哈希，不会误报

### 3.2 第 2 层：`fixer-safety-check.json` 由 CLI 现算（`src/core/healing_state.ts`）

**根本问题**：哈希审计防"事后篡改"，防不了"写入即假"。`aws state heal --to applied` 目前只校验 agent 手写文件的 `passed == true`（`validatePreconditions` 的 `proposal_created → applied` 分支）——改为 **CLI 现场计算并写入**该文件，agent 手写版本被覆盖：

| 字段（fixer-safety-gate 消费） | CLI 判定方式 |
|---|---|
| `product_code_modified` | §1 产品树 hash：当前 vs 上一 formal batch 基线，一行比对 |
| `skip_or_xfail_added` | `git diff -- tests/` 新增行匹配 `pytest\.mark\.(skip|xfail)|unittest\.skip` |
| `unrelated_tests_modified` | 变更文件集合（tests 树 hash 差集，不依赖 git）⊄ `fix-proposal.json` 各 proposal `files_to_modify` 并集 |
| `assertion_expected_value_changes_detected` | 启发式：diff 中 `assert` 行的字面量/状态码变化 → **不直接判 false**，检出时置 `needs_review: true` 并在文件中列出可疑行；gate 对 needs_review 走 `needs_human_review` 而非 pass |
| `high_risk_proposal_applied` | `fix-proposal.json` 中 `risk_level == 'high'` 的 proposal 是否出现在 apply-summary `files_modified` |
| `passed` | 以上全部通过的合取 |

- git 不可用时：`skip_or_xfail_added` / `assertion_expected_value_changes_detected` 置 `"undetermined"` 并强制 `needs_review: true`（fail-closed 到人工，不是 fail-open 到 pass）
- schema 同步：`fixer-safety-gate` 新增 `needs_human_review_when: "needs_review == true"`

### 3.3 第 3 层：safety gate 纳入 verdict 迁移审计（`audit.ts` `checkVerdictMigration`）

- safety 类 gate 的 `pass→pass` 且 `reads_sha256` 变化 → 默认 `GATE-TRANSITION-ILLEGAL`
- **豁免（防误伤 healing 重检）**：两次 verdict 之间存在 `phase_transition(healing-rerun|healing-reinspect)` 或 `execution_start` 事件 → 放行（healing 循环合法重写证据）

---

## 4. 机制 D：`assertion_failure` 拆分半自动通道（对应讨论中的方案 2）

### 4.1 新类别（`src/core/types.ts` + `src/report/failure_classifier.ts`）

```ts
// FailureCategory 新增
'assertion_expectation_error'   // 测试期望值写错（非产品行为错）

// FIX_PROPOSAL_ALLOWED 新增
assertion_expectation_error: 'review',   // 复用现有 needsReview 机制
```

`assertion_failure`（默认判定）保持 `false` 不变——**保守默认不动，只开一条显式升级通道**。

### 4.2 重分类必须经 CLI（新增 `aws report reclassify`）

文本启发式无法区分"期望写错"与"产品行为错"——这个判断需要对照 case.yaml/plan 的语义，属于 aws-inspect skill（LLM）的职责；但**分类结果的写入必须经 CLI 留痕**，不允许 skill 直接改 `failure-analysis.json`（否则违背 state-machine-enforcement 的 provenance 原则）：

```bash
aws report reclassify --change <id> --failure <test_id> \
  --to assertion_expectation_error \
  --evidence "case.yaml TC_USER_012 期望 403，测试写了 200；plan 亦为 403"
```

- 前置校验：原类别必须是 `assertion_failure`；`--evidence` 非空；目标类别在白名单（初期仅 `assertion_expectation_error`）
- 行为：更新 `failure-analysis.json` 对应 failure（`category`、`fix_proposal_eligible: true`、`needs_review: true`、`reclassified: {from, evidence, at}`），追加事件 `{ source:'report', type:'failure_reclassified', … }`
- audit 补充：`failure-analysis.json` 中存在 `reclassified` 字段但事件流无对应 `failure_reclassified` 事件 → `RECLASSIFY-WITHOUT-EVENT`（stopped 级）

### 4.3 半自动语义（下游不改代码，只改文档约定）

- `needs_review: true` 的 proposal 生成后，fixer skill **必须**等 human approve（`aws decide --at healing.safety --action accept_risk`）才可 apply——写入 `skills/aws-fix-proposal/SKILL.md` 硬规则
- §3.2 的 `assertion_expected_value_changes_detected` 对经 4.2 重分类的用例**豁免该文件的对应行**（proposal 明确授权改期望值），其余文件仍全量检测

---

## 5. 不改变的部分（明确边界）

- healing 状态机 `LEGAL_TRANSITIONS` 与各转换前置**不动**（§3.2 只是把其中一个前置的证据来源从 agent 换成 CLI）
- tests 树 hash 守卫（前序 spec）行为**不动**；机制 B 只是给已有 override 通道补证据
- `assertion_failure` 默认不可修**不动**；机制 D 是显式、留痕、人审的升级通道
- 首次 `aws run`（无基线）不受影响；非 git 项目全部功能可用（diff 类字段降级为 undetermined/null）
- 防护目标不变：**防纪律漂移，不防恶意对抗**（LLM 对 change 目录有写权限，密码学级防伪造不可行也不是目标）

---

## 6. Schema 与 SKILL 文档同步

| 文件 | 改动 |
|---|---|
| `schemas/workflow-schema.yaml` | `fixer-safety-gate` 新增 `needs_human_review_when: "needs_review == true"`；gate reads 注释标注"由 CLI 生成，agent 手写无效" |
| `skills/aws-run/SKILL.md` | 新增 "Product tree integrity" 小节（PRODUCT-CHANGED-DURING-HEALING 语义）；"Rerun integrity" 小节补 override 证据文件说明 |
| `skills/aws-execute/SKILL.md` | Runbook：override 使用后必须核对 `test-changes-override.json` 已生成；healing 期间禁触产品代码由 CLI 机械强制 |
| `skills/aws-workflow/SKILL.md` | Healing hard rules 追加："fixer-safety-check 由 `aws state heal` 现算，手写无效"；"assertion 期望值错误走 `aws report reclassify`，禁止直改 failure-analysis.json" |
| `skills/aws-inspect/SKILL.md` | 新增 reclassify 流程：何时可判 `assertion_expectation_error`（必须引用 case.yaml/plan 证据）、命令用法 |
| `skills/aws-fix-proposal/SKILL.md` | `needs_review` proposal 必须 human approve 后才可进 fixer |
| `src/templates/config-yaml.ts` | `product_code_roots` 默认值 |
| `src/templates/execution-policy.ts` | `testChangesOverride` 字段（local: with-evidence / ci: forbidden） |

---

## 7. 验收标准

### 7.1 单元测试

**机制 A**（`tests/unit/core/product_tree_guard.test.ts`）：
1. 首跑无基线 → 放行，manifest 写入 `product_tree_sha256`
2. 产品树未变 + healing 重跑 → 放行
3. 产品树已变 + healing 重跑（`isHealingRunContext == true`）→ **throw PRODUCT-CHANGED-DURING-HEALING**
4. 产品树已变 + 普通重跑 → 放行 + `product_tree_changed` 事件 + 基线重置
5. `product_code_roots` 目录不存在 → 静默跳过

**机制 B**（`tests/unit/commands/override_evidence.test.ts`）：
1. override 放行 → `test-changes-override.json` 存在，`changed_files` 含 old/new sha256 与 change_type（modified/added/deleted 三态各一例）
2. `human_override` 事件含 `evidence_file` + `evidence_sha256`
3. 证据文件写入后被篡改 → `aws status` 报 `ARTIFACT-TAMPERED`
4. 非 git 项目 → `git_diff_file: null`，其余字段完整
5. policy `forbidden` → usage error；`with-evidence` 且证据写入失败 → run 拒绝

**机制 C**（扩展 `tests/unit/core/audit.test.ts`）：
1. `fixer-safety-check.json` 在 gate verdict 后被改 → `ARTIFACT-TAMPERED`
2. 旧 change（事件无 safety hash）→ 无误报
3. healing-reinspect 重写 safety-check 后 `pass→pass` → **不报**（豁免生效）；无 healing 事件的 `pass→pass` 内容变化 → 报
4. CLI 计算 fixer-safety-check：diff 加 `pytest.mark.xfail` → `skip_or_xfail_added == true`；改 `app/` 文件 → `product_code_modified == true`；改 proposal 外文件 → `unrelated_tests_modified == true`；git 不可用 → `needs_review == true`

**机制 D**（`tests/unit/report/reclassify.test.ts`）：
1. `assertion_failure` → `assertion_expectation_error` 且 evidence 非空 → 成功，`fix_proposal_eligible == true`、`needs_review == true`、事件落盘
2. 原类别非 `assertion_failure` / evidence 为空 / 目标类别不在白名单 → 拒绝
3. 手改 `failure-analysis.json` 加 `reclassified` 但无事件 → `RECLASSIFY-WITHOUT-EVENT`

### 7.2 事故重演

1. **重演 healing 改产品代码**：healing applied 后手改 `app/controllers/user.py` → `aws run` 被 PRODUCT-CHANGED-DURING-HEALING 机械拒绝
2. **重演 RET-user-management 决策**：`execution.test-changes` 授权修 3 个文件 → 报告 "Human Decisions" 小节列出 3 个文件与 diff 指针
3. **重演 RET-api-management 手写 safety-check**：agent 手写 `passed: true` → 被 `aws state heal --to applied` 的 CLI 现算覆盖，若实际改了产品代码则 gate STOP

### 7.3 工程完整性

- `tsc --noEmit` 干净；全量 jest 通过
- **`npm run build` 完成后 `rg PRODUCT-CHANGED-DURING-HEALING dist/` 有命中**（前序 spec 教训：改 src 不 build = 零生效）
- `aws skill refresh --build-link` 后目标项目可见新 SKILL 文案

---

## 8. 实施顺序

1. **机制 B**（最小、数据现成、独立可发布）：`healing_state.ts` 结构体扩展 → `run.ts` 证据落盘 + 事件 → 报告小节 → policy 开关
2. **机制 C 第 1 层**：`audit_scope.ts` 常量 + 三处接线 + audit 扩展（含 B 的 evidence_sha256 校验）
3. **机制 A**：`hashProductTree` → manifest 字段 → healing 守卫 → config 模板
4. **机制 C 第 2 层**（依赖 A 的产品树基线）：`heal --to applied` 现算 fixer-safety-check + schema needs_review 分支
5. **机制 C 第 3 层**：迁移审计豁免规则
6. **机制 D**：类别 + reclassify 命令 + audit 规则 + SKILL 文档
7. §6 全部文档同步 → build → dist 验证

### Backlog（显式不做）

- `inspect-safety-check.json` 上游标准化（inspect-safety-gate 目前仅存在于项目本地 schema 副本；待 fixer-safety-check CLI 化验证后，再决定是否把 inspect 侧安全检查并入 `aws report inspect` 输出并进规范 schema）
- `assertion_expectation_error` 的自动检出（CLI 对照 case.yaml expected 与断言字面量）——先靠 skill 判断 + CLI 留痕，积累重分类样本后再评估
- 产品树 hash 的性能优化（大仓库增量 hash / mtime 预筛）——先测 vue-fastapi-admin 规模（约千级文件）的实际耗时
- 测试变更决策与 healing 的使用率对比看板（B 落地后事件数据自然可查）
