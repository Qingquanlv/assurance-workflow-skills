# 产物 Schema 单一真相源：模板归属、`aws validate` 与 skill 去副本

> 目标：回答一个长期悬空的问题——**「生成的 YAML/JSON 产物要不要定义模板？模板放 docs 还是由 CLI 生成？谁来校验？」**
> 结论先行：per-change 结构化产物（YAML/JSON）的 **schema 收敛为代码里的单一真相源（`src/schema/`）**；
> 运行时实例只落 SUT 的 `qa/changes/<id>/`，**永不进 docs**；新增 `aws validate` 做确定性校验；
> skill markdown 从「内嵌完整模板副本」改为「最小示例 + 引用 schema」，消除副本漂移。
>
> 边界：本文只管**产物的形状与校验**。执行模型（driver-first / fallback）见 `workflow-driver.md`；
> CLI 命令删减与裁决收敛见 `boundary-inventory.md`。本文不重复这两者，只在 §6 说明衔接。

---

## 0. 背景与动机

### 0.1 现状：产物模板三套并存，且没有统一真相源

当前一个 change 从 explore 走到 archive，会产出十几种结构化产物（见 §1 清单）。它们的「模板/契约」目前分散在三处，互不统一：

| 层 | 产物 | 模板/契约现在放哪 | 谁生成 | 现在怎么校验 |
|---|---|---|---|---|
| A | `.aws/config.yaml`、`.aws/module-map.yaml` 等 init 文件 | TS 生成器 `src/workflow/templates/*.ts` | `aws init` | `src/workflow/core/checks.ts`（doctor） |
| B | `workflow-schema.yaml` | `schemas/workflow-schema.yaml`（随包发布） | 不生成，运行时按优先级解析覆盖 | `src/workflow/orchestration/schema.ts` loader |
| C | per-change 产物（`case.yaml`/`.qa.yaml`/plan/review/execution/inspect/report/healing） | **内嵌在 skill 的 markdown 正文里**（如 `aws-case-design/SKILL.md` 约 1500 行、含数十个 ```yaml``` 模板块） | agent（跑 skill） | **无统一校验**，只有 gate 检查「文件是否存在」+ hash/mtime |

C 层就是问题所在：

- **没有机器可读的 schema。** case.yaml、fix-proposal.json 长什么样，唯一权威是 skill markdown 里的散文 + 示例块。`aws gate check` 只能判断「文件在不在」，判断不了「字段对不对」。
- **模板副本会漂移。** 同一个 case 结构，在 `aws-case-design`、`aws-case-reviewer`、`aws-case-fixer` 里各写一遍；改一处忘改另一处，reviewer 就会按旧契约挑错。
- **「放 docs 还是 CLI 生成」没有定论。** A 层是 CLI 生成、B 层放 docs、C 层塞进 skill——三种做法，没人说清楚新产物该走哪条。

### 0.2 为什么现在治

`boundary-inventory.md` 已经把「过程管制侧」收敛（裁决、状态推导、CLI 删减）。但它管的是**流程与状态**，没碰**产物形状**。产物 schema 是另一条正交的复杂度来源：只要契约还散在 markdown 里且不可机器校验，reviewer/fixer 之间就会持续因「契约理解不一致」空转。这正好补上 `boundary-inventory.md` 没覆盖的一块。

---

## 1. 范围与非目标

### 覆盖（per-change 结构化产物，来自 `workflow-schema.yaml` 的 `produces`）

**YAML：**

- `workflow-state.yaml`（运行时相位状态，orchestrator 写）
- `.qa.yaml`（change 元数据）
- `cases/<module>/case.yaml`（case delta）
- `execution/execution-manifest.yaml`

**JSON：**

- `explore/advisory.json`
- `review/case-review.json`、`review/api-plan-review.json`、`review/plan-review.json`、`review/fuzz-plan-review.json`、`review/performance-plan-review.json`
- `facts/fact-baseline.json`
- `inspect/failure-analysis.json`、`inspect/quality-gate-result.json`
- `report/quality-report.json`
- `healing/fix-proposal.json`、`healing/api-apply-summary.json`、`healing/e2e-apply-summary.json`

### 非目标

- **不管 Markdown 产物**（`proposal.md`、`plans/*.md`、`codegen/*-summary.md`、`review/*-apply-summary.md`、`report/*.md`）。这些是自然语言，契约留在 skill 里，本文不 schema 化。
- **不改 A 层 init 模板与 B 层 workflow-schema**。它们已有各自 loader/校验，形态保留。
- **不改执行模型、不删 CLI 命令**（见 `workflow-driver.md` / `boundary-inventory.md`）。
- **不引入运行时 YAML 生成骨架**（曾考虑的 `aws scaffold` 方案已否决，理由见 §3.3）。

---

## 2. 产物三层归属模型（一次讲清「放 docs 还是 CLI 生成」）

确立一条判定规则，今后任何新产物按此归层：

| 层 | 判据 | 模板/schema 归属 | 生成方式 | 实例落位 |
|---|---|---|---|---|
| **A · 项目级配置** | 每个 SUT 一份、init 时创建、之后人工维护 | TS 生成器 `src/workflow/templates/` | **CLI 生成**（`aws init`） | SUT `.aws/` |
| **B · 引擎级 schema** | 全局一份、定义工作流拓扑本身 | `schemas/*.yaml`（随包发布，可被 `.aws/` 覆盖） | **不生成**，运行时解析 | 随包 / SUT 覆盖 |
| **C · per-change 产物** | 每个 change 每相位一份、由 agent 创造性生成 | **`src/schema/`（本文新增，单一真相源）** | **agent 生成、CLI 校验** | SUT `qa/changes/<id>/`（运行时，**不进 docs**） |

一句话回答你最初的问题：

- **YAML 模板要不要定义？** 要，但定义的是 **schema（形状约束）**，不是「填空模板文件」。
- **放 docs 还是 CLI 生成？** C 层产物的 **schema 放代码**（`src/schema/`，随代码测试与版本演进）；**实例由 agent 生成**、由 **CLI 校验**；**docs 只放人读的索引**（`docs/schemas.md`），**不放运行时实例**。

---

## 3. C 层产物的 Schema 单一真相源

### 3.1 目录与形态

新增 `src/schema/`，每种 C 层产物一个模块，导出 **TS 类型 + 运行时校验器**：

```
src/schema/
  index.ts                  # 注册表：artifact 路径 glob → validator 映射
  case_yaml.ts              # cases/<module>/case.yaml
  qa_yaml.ts                # .qa.yaml
  workflow_state.ts         # workflow-state.yaml（复用现有 types，补 validator）
  execution_manifest.ts     # execution/execution-manifest.yaml
  review.ts                 # review/*.json（共享 verdict 结构）
  fact_baseline.ts          # facts/fact-baseline.json
  advisory.ts               # explore/advisory.json
  failure_analysis.ts       # inspect/failure-analysis.json
  quality_gate_result.ts    # inspect/quality-gate-result.json
  quality_report.ts         # report/quality-report.json
  fix_proposal.ts           # healing/fix-proposal.json
  apply_summary.ts          # healing/{api,e2e}-apply-summary.json
```

每个模块统一导出：

```ts
export const schemaVersion = "1.0";
export type CaseYaml = { /* ...结构... */ };
export function validateCaseYaml(raw: unknown): ValidationResult;
// ValidationResult = { ok: true } | { ok: false; errors: SchemaError[] }
```

`src/schema/index.ts` 维护 **artifact 相对路径 glob → validator** 的注册表，是 `aws validate` 与 gate 的共同入口。

### 3.2 技术选型：TS 类型 + 运行时 validator

- **真相源是 TS**（团队全 TS，类型即文档，能进单测）。运行时校验用轻量 schema 库（如 `zod`）或手写纯函数——二选一在实现计划里定，接口不变。
- **可选导出 JSON-Schema**：validator 能 `toJSONSchema()` 落一份 `schemas/*.json`，供非 TS 消费者与文档索引使用。JSON-Schema 是**派生物**，不是真相源，避免双写。
- `schema_version` 字段每种产物自带，validator 按版本分派，为将来演进留位。

### 3.3 否决的备选方案

- **`aws scaffold` 生成空模板文件**：让 agent 填空。否决——agent 本就擅长按 schema 生成完整结构，空骨架既多一步 IO，又容易让 agent 只填不改骨架、产生半成品；校验才是真正缺的能力，不是骨架。
- **schema 放 docs（YAML/JSON-Schema 为真相源）**：否决——脱离类型系统与单测，改 schema 不过 CI，回到「散文契约」老路。
- **继续内嵌在 skill markdown**：否决——即现状，副本漂移的根因。

---

## 4. `aws validate` 命令接口设计

新增确定性、无 LLM 的校验命令（与 `status`/`gate check` 同类），让 driver、eval
与人工操作共享同一校验入口。当前命令参数、选择规则、输出与退出码的用户契约以
[`docs/schemas.md`](../../docs/schemas.md#validate-change-artifacts) 为准；本设计文档不复制
该规范性说明。

**与 gate 的关系**：`aws gate check` 的 codegen/plan/case 相关硬门，从「文件存在 + hash」升级为「文件存在 + **schema 校验通过**」，二者都调用 `src/schema` 的同一 validator，不各写一套。driver 主循环的「产物校验」步（`workflow-driver.md` §「产物校验 → H0 → reducer → gate」）由此有了统一实现，取代当前「目录/YAML/Markdown 各自 validator」的模糊说法（Markdown 仍走存在性检查）。

---

## 5. skill markdown 去副本迁移

对每个生成 C 层产物的 skill（`aws-case-design`、各 reviewer/fixer、`aws-fix-proposal`、`aws-inspect`、`aws-report-generator` 等）：

1. **删除内嵌的完整模板/字段清单副本**，替换为：
   - 一段**最小示例**（3–5 行，帮 agent 建立直觉）
   - 一句**权威指引**：「完整字段与约束以 `src/schema/<x>.ts` 为准；产出后必须能通过 `aws validate --change <id> --artifact <path>`」
2. **自然语言语义**（怎么判 P0/severity、delta 规则等**判断性**内容）**保留在 skill**——那不是 schema 能表达的，是 skill 的价值所在。
3. reviewer/fixer skill 里「检查产物结构合规」的散文清单，改为「运行 `aws validate` 并读取 `errors[]`」，把结构校验从 agent 主观判断变成确定性调用。

净效果：**结构约束单点化（代码）**，**语义判断留在 skill（散文）**，两者不再混在一起，也不再有 N 份漂移副本。

---

## 6. 与现有文档的边界

| 关注点 | 归属文档 | 本文关系 |
|---|---|---|
| 谁编排、skill 是不是 worker、fallback 降级 | `workflow-driver.md` | 只引用；本文的「产物校验」填充其循环中的校验步 |
| CLI 命令删减、裁决收敛、healing 证据推导 | `boundary-inventory.md` | 正交；`aws validate` 是**新增**确定性内核命令，符合其「保留确定性内核」原则，不在其删除清单内 |
| nightly / retro 产物（`context.json`/`proposals.json`） | `nightly-driver.md` / `retro-self-improvement-loop.md` | 非本文范围（那些 schema 已在各自 types 中）；如需统一，后续可把它们也纳入 `src/schema/` 注册表 |
| workflow-schema.yaml 的 `produces` 字段 | `workflow-schema.yaml` | 本文以其为**产物清单真相源**；validator 注册表须与 `produces` 对齐（§7 加一致性测试） |

---

## 7. 测试计划

- **每个 validator 一组单测**（`tests/unit/schema/*.test.ts`）：合法样例通过；每类必填缺失/类型错/枚举越界各一条负例；`schema_version` 分派正确。
- **注册表一致性测试**：遍历 `workflow-schema.yaml` 所有 `produces` 中的 YAML/JSON 产物，断言每一个在 `src/schema/index.ts` 有对应 validator（防止加了产物忘了 schema）。
- **`aws validate` 契约测试**（`tests/integration/commands/validate.test.ts`）：临时 change 目录 + fixture 产物；全过退出 0；注入坏产物退出 1 且 `errors[]` 指向具体字段；`--phase`/`--artifact` 过滤正确。
- **gate 集成**：codegen/plan/case 硬门在产物 schema 不合法时给出非 pass verdict，且理由引用 validator error。
- **skill 去副本回归**：`rg` 断言被迁移的 skill 不再内嵌完整字段清单（只留最小示例 + `src/schema` 引用）；契约测试确保 skill 引用的 schema 路径真实存在。

---

## 8. 落地顺序（供后续 writing-plans 展开）

1. 建 `src/schema/` 骨架 + `index.ts` 注册表 + `ValidationResult` 类型；先纳入 1 个产物（`case.yaml`）打通端到端。
2. 补 `aws validate` 命令，接 case.yaml validator，写契约测试。
3. 逐个补齐其余 C 层产物 validator（按 review → fix-proposal → inspect → report 优先级，healing 最后）。
4. 加注册表 vs `produces` 一致性测试。
5. gate check 接入 schema 校验（替换存在性/hash 单点）。
6. skill markdown 去副本迁移（一个 skill 一个 PR，配 rg 回归）。
7. 可选：validator 导出 JSON-Schema → `schemas/` + 更新 `docs/schemas.md` 的人类索引。

---

## Implementation status

Implemented per `engineering/plans/2026-07-13-artifact-schema-ssot.md`:
`src/schema/` registry + validators, `aws validate` command, gate schema
integration, and skill de-duplication. Registry coverage is enforced by
`tests/unit/schema/registry_consistency.test.ts`.
