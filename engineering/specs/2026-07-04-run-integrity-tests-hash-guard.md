# Run 完整性 Spec：测试树 hash 守卫 + rerun-reason 收窄

> **Historical engineering record.** Dated CLI, path, configuration, and behavior
> examples are non-normative. Use `docs/` for current user-observable behavior.

**日期**: 2026-07-04
**版本**: v1.0
**状态**: Implemented
**涉及面**: `src/execution/runner.ts`、`src/commands/run.ts`、`src/core/healing_state.ts`、`src/core/events.ts`、`src/core/audit.ts`、`skills/aws-{workflow,execute,run}/SKILL.md`
**关联设计**:
- [engineering/design/state-machine-enforcement.md](../design/state-machine-enforcement.md)（healing 状态机 + provenance 架构）
- [2026-07-04-three-problems-stability-spec.md](2026-07-04-three-problems-stability-spec.md)（前序 spec；本 spec 封其 §2 遗留的入口洞）

---

## 0. 问题与方案映射

### 0.1 实测事故（RET-api-management 第二轮，2026-07-04 19:12）

```
正式 aws run（batch 20260704-191257）→ 4 个失败
  ↓
agent 直接改测试代码（含：TC_API_017 改断言期望值、TC_API_013 加 xfail）
  ↓
aws run --rerun-reason "<随意文字>" → 放行 → 全绿 → 报告 96 分 PASS
  ↓
healing.status 全程停留 pending；fixer-safety-gate 两条禁令
（assertion_expected_value_changes_detected / skip_or_xfail_added）被完整绕空
```

### 0.2 根因

现有强制层的洞恰好开在"从未启动 healing"的路径上：

| 守卫 | 生效条件 | 洞 |
|---|---|---|
| `assertHealingRunAllowed` | 仅当 `isHealingRunContext == true`（healing 已离开 pending 或有 apply-summary） | healing 从未启动 → 守卫直接 return，不检查 |
| `assertRerunReasonIfNeeded` | execution 已完成时要求 `--rerun-reason` | 只要求**任意非空文字**，且报错信息 `pass --rerun-reason <text>` 当场教会绕过 |
| `rerun-reason` 语义 | — | 所有 SKILL 文档中出现 **0 次**，无合法使用场景定义 |

四次执行（user-management / dept-management / api-management ×2）healing 绕过率 100%，全部发生在入口之前。

### 0.3 方案一句话

> `aws run` 每个 batch 把 `tests/` 树的逐文件 SHA256 记入 execution-manifest；重跑时若测试文件相对上一 batch 发生变化且 `healing.status != applied` → **硬拒绝**（`--rerun-reason` 无效）。`rerun-reason` 收窄为仅限"代码未变"的重试（环境抖动类）。人工介入走显式 override 通道并留 `human_override` 事件。

**验收总标准**：重演 0.1 的事故路径，第二次 `aws run` 被机械拒绝，报错指引正式 healing 循环或人工 override，不提供任何单参数即可通过的旁路。

---

## 1. 机器规格

### 1.1 Manifest 新增字段（`src/execution/runner.ts`）

`execution/execution-manifest.yaml`（及 batch 副本）新增：

```yaml
tests_tree_sha256: <aggregate sha256>        # 对排序后的 (relpath, file_sha256) 序列整体求 hash
test_files_sha256:                           # 逐文件，用于变更诊断报文
  tests/api/test_api_api.py: <sha256>
  tests/e2e/test_api_e2e.py: <sha256>
  # ...
```

**Hash 范围（全量，防清单外新增文件逃逸）**：

- 根：`<projectRoot>/tests/` 递归全部文件
- 排除：`__pycache__/`、`*.pyc`、`.pytest_cache/`、隐藏文件
- 排序：relpath 字典序；aggregate = `sha256(join(relpath + ":" + file_sha256, "\n"))`
- 复用 `src/core/hash.ts` 的 `sha256File` / `sha256String`；新增 `hashTestTree(projectRoot): { aggregate, files }`（建议放 `src/core/hash.ts`）

### 1.2 `aws run` 入口守卫（`src/commands/run.ts` + `src/core/healing_state.ts`）

在现有 `assertHealingRunAllowed` / `assertRerunReasonIfNeeded` 之后新增第三道检查 `assertTestTreeUnchangedOrHealing`：

```text
读上一 batch 的 execution-manifest.yaml：
  无 manifest 或 manifest 无 tests_tree_sha256（旧版本产物）→ 放行（fail-open 一次，本次起记录 hash）

计算当前 hashTestTree：
  aggregate 与上一 batch 一致 → 放行（rerun-reason 仍按现有规则要求）
  aggregate 不一致：
    healing.status == applied            → 放行（正式 healing 重跑；applied 的前置已由
                                            healing_state.ts 强制：apply-summary + fixer-safety-check passed）
    存在有效 override（见 §1.3）          → 放行 + 记录事件
    否则                                  → throw TESTS-CHANGED-WITHOUT-HEALING（--rerun-reason 不参与判定）
```

**错误码与文案（教正路，不教旁路）**：

```text
TESTS-CHANGED-WITHOUT-HEALING: test files changed since batch <batch_id> (<n> files, e.g. <top-3 relpaths>)
but healing.status=<status>. Test modifications after a formal run MUST go through the healing loop:
  aws-fix-proposal → fixer skill → aws state heal --to applied → aws run
If a human explicitly decided to modify tests outside healing, record it first:
  aws decide --change <id> --at execution.test-changes --action allow_test_changes --reason "<user decision>"
  aws run --change <id>
```

- 文案**不得**出现"pass --rerun-reason"这类单参数提示
- 变更文件列表取 `test_files_sha256` 差集，最多列 3 个 + 总数

### 1.3 人工 override 通道（`src/commands/run.ts` + `src/core/events.ts`）

```bash
aws decide --change <id> --at execution.test-changes --action allow_test_changes --reason "<user decision>"
aws run --change <id>
```

- `--allow-test-changes` 必须与 `--reason`（非空）同时出现，否则 usage error
- 放行前追加事件（复用现有 `HumanOverrideEvent`）：

```jsonc
{ "source": "run", "type": "human_override",
  "phase": "execution", "action": "allow_test_changes",
  "reason": "<user decision>",
  "review_sha256": "<当前 tests_tree_sha256>" }   // 语义复用：记录被批准的测试树快照
```

- **SKILL 侧红线**（写入 §3 文档同步）：agent 仅在用户**显式**做出该决定后才允许使用此 flag；autonomous 模式下主动使用 = 违规，审计可见（事件流中 human_override 无对应用户停顿即可人工核查）

### 1.4 `rerun-reason` 语义收窄

- **合法**：测试树未变化的重跑——环境抖动、SUT 重启、基础设施超时、验证偶现失败
- **非法**：任何"我修了测试"场景（被 §1.2 机械拦截，与 reason 文字无关）
- `ExecutionStartEvent` 新增可选字段 `tests_changed: boolean`（相对上一 batch），供审计回溯

### 1.5 审计补充（`src/core/audit.ts`，backlog 可后置）

- `MANIFEST-MISSING`：events 流存在 ≥1 个 `execution_start` 但 `execution/execution-manifest.yaml` 不存在 → 疑似 manifest 被删重置基线
- `RUN-OVERRIDE-RECORDED`：info 级列出所有 `allow_test_changes` 事件，进 `aws status` 输出（不置 stopped，仅可见性）

---

## 2. 不改变的部分（明确边界）

- healing 状态机（`LEGAL_TRANSITIONS`、各转换前置）**不动**——本 spec 是封入口，不是重设计
- 多 skill healing 编排（fix-proposal → fixers → rerun → re-inspect）**不动**；是否合并为单 `aws-heal` 调度，待本守卫上线后依据实测再议（见 §5 backlog）
- `fixer-safety-gate` / `inspect-safety-gate` 规则不动
- 首次 `aws run`（无前序 batch）不受影响

---

## 3. SKILL 文档同步

| 文件 | 改动 |
|---|---|
| `skills/aws-run/SKILL.md` | 新增 "Rerun integrity" 小节：tests hash 守卫行为、`TESTS-CHANGED-WITHOUT-HEALING` 含义、rerun-reason 合法场景清单、`--allow-test-changes` 仅限用户显式决定 |
| `skills/aws-execute/SKILL.md` | Runbook Phase 7 后加一行："formal run 之后任何测试代码修改 = healing 范围；`aws run` 以 tests hash 机械强制，改了代码的重跑必须先 `heal --to applied`"；Phase 11 标注 rerun 放行依据是 `applied` |
| `skills/aws-workflow/SKILL.md` | Healing hard rules 追加一条："**Never** modify test files between batches outside the healing loop — enforced by tests-tree hash in `aws run`"；rerun-reason 语义同步 |
| `engineering/design/state-machine-enforcement.md` | 追加 §"Run integrity（tests hash）"引用本 spec |

---

## 4. 验收标准

### 4.1 单元测试（新增 `tests/unit/core/run_integrity.test.ts` 或并入现有）

1. 首跑无基线 → 放行，manifest 写入 `tests_tree_sha256` + `test_files_sha256`
2. 测试树未变 + rerun-reason → 放行
3. 测试树已变 + healing.status=pending + rerun-reason → **throw TESTS-CHANGED-WITHOUT-HEALING**，报文含变更文件名
4. 测试树已变 + healing.status=applied → 放行
5. 测试树已变 + `--allow-test-changes --reason "x"` → 放行且事件流有 `human_override(action=allow_test_changes)`
6. `--allow-test-changes` 缺 `--reason` → usage error
7. 旧 manifest（无 hash 字段）→ 放行一次，本次 manifest 补齐 hash
8. hashTestTree 排除 `__pycache__` / `.pyc`

### 4.2 事故重演

重演 §0.1 路径：改断言 + 加 xfail 后重跑 → 第二次 `aws run` 被拒；走正式 healing 时 fixer-safety-gate 对同样改动 STOP → 上升人工。

### 4.3 工程完整性

- `tsc --noEmit` 干净；全量 jest 通过
- **`npm run build` 执行完成，且 `rg TESTS-CHANGED-WITHOUT-HEALING dist/` 有命中**（本轮事故教训：`bin.aws → dist/cli.js`，改 `src` 不 build = 零生效）

---

## 5. 实施顺序

1. `src/core/hash.ts`：`hashTestTree`（含排除规则）+ 单测
2. `src/execution/runner.ts`：manifest 写入两个 hash 字段
3. `src/core/healing_state.ts`：`assertTestTreeUnchangedOrHealing`（读上一 manifest、比对、错误报文）
4. `src/commands/run.ts`：接线新守卫 + `--allow-test-changes/--reason` + `human_override` 事件 + `execution_start.tests_changed`
5. 单测 + 全量回归
6. §3 四处文档同步
7. **`npm run build`** + dist 验证
8. （backlog）§1.5 两条审计；healing 编排是否合并单 skill 待实测证据

### Backlog（显式不做）

- pytest 直跑绕过 `aws run` 的检测（依赖"结果必须出自 CLI manifest"既有红线 + MANIFEST-MISSING 审计兜底）
- codegen 阶段预置 xfail 的生成时检测（归 plan-review / case-review gate 职责）
- 多 skill healing 合并为 `aws-heal` 单调度（待守卫上线后的实测数据）
