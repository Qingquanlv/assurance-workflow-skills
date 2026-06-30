# aws-explore: 浅读源码 + 一次一问交互设计

**日期**: 2026-06-30  
**版本**: v1.0  
**作者**: 设计对话

---

## 背景与动机

当前 `aws-explore` 是纯历史证据合成阶段（diff + archive），不读源码、不与用户交互。这带来两个问题：

1. **open_questions 断链**：`advisory.json` 里生成了 `open_questions_for_case_design[]`，但 `aws-case-design` 的对话逻辑里没有显式消费它。等于 explore 辛苦产出的问题无人追问，下游只能按 8 类澄清模板重问一遍，和 advisory 脱节。

2. **无历史数据 → 近乎空 advisory**：当 change 无 git diff、无 archive 历史时，三项证据全空，现行"三全空 → unavailable"硬规则让 explore 近乎跳过。事实上代码结构（路由、模型）是确定性存在的证据，可以基于它产出真实的 coverage guidance，而不是返回空壳。

**目标**：让 `aws-explore` 在历史数据不足时也能产出有意义的产物，同时让 `open_questions` 真正在 explore 阶段被用户回答，避免 case-design 重复询问。

---

## 设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 读码机制 | Skill 层浅读（Read/Grep），不改 CLI | 保持 CLI 确定性；代码探查是 LLM 擅长的非结构化工作 |
| 读码范围 | 后端路由定义 + 模型字段名 + 前端目录结构 | 足以产出"接口形状"级别的 evidence；不读业务逻辑细节，避免与 case-design 重叠 |
| open_questions 追问方式 | 一次一问（与 case-design 风格一致） | 用户体验一致；批量展示会让用户不知道该按哪个答 |
| 答案去重 | 写入 `advisory.json open_questions[].answer`；case-design 读取后跳过已答项 | 单一事实来源；case-design 无需感知"这是 explore 问过的" |

---

## 新执行流程

```
Step 1  aws risk context (diff + 历史)       [不变]
Step 2  弱数据门 (语义扩展)                   [改]
Step 3  浅读源码                              [新增]
Step 4  LLM 合成 advisory 草稿               [改: 加入 code-derived evidence]
Step 5  一次一问追问 open_questions           [新增交互]
Step 6  写 advisory.json + 校验              [不变]
Step 7  更新 workflow-state.yaml             [不变]
```

---

## Step 2 — 弱数据门（改）

### 当前规则（问题所在）

当 `no_diff + no_cases + no_history` 全中时，直接 `status = unavailable`。

### 新规则

三项历史数据全空时，**不直接 unavailable**，而是进入 Step 3 读源码。读完源码后再判断：

| 条件 | Action |
|------|--------|
| 历史数据不全，源码读到有效结构 | 继续合成；全局置信度封顶 `medium`；`executive_summary` 标注"无历史证据，基于代码结构合成" |
| 历史数据不全，源码也为空（无路由、无模型、空目录） | `status = unavailable` |
| 历史数据不全，`weak_data_treat_as = unavailable` | 保持原语义；跳过源码读取直接 unavailable |

**效果**：截图中"无 diff/无历史 → 近乎空 advisory"变为"无历史 → 基于代码产出 medium 级 guidance"。

---

## Step 3 — 浅读源码（新增）

### 读取范围

**后端（必读，如可找到）**：
- 路由定义文件（`routes/`, `router.ts`, `*router*.ts`, `*.routes.ts`）→ 提取 HTTP method + path + handler 名
- 模型定义文件（`models/`, `entities/`, `*model*.ts`）→ 提取字段名、类型、约束关键词（required, unique, FK）
- 权限配置（`rbac`, `permission`, `guard` 相关）→ 提取角色名或权限枚举

**前端（目录结构，不读组件内部）**：
- 列目标模块的目录层级 + 文件名，不读组件/页面内容

**不读**：
- 现有测试源码（属于 aws-test-author 范围）
- 业务逻辑实现细节（属于 case-design 范围）
- 配置 / 环境文件

### 证据记录

读到的结构作为新 evidence 来源：

```json
{
  "id": "SC-001",
  "source": "source_code",
  "type": "api_route | model_field | rbac_role | frontend_structure",
  "description": "...",
  "parse_confidence_cap": "medium"
}
```

所有 `source: "source_code"` 的 evidence 置信度上限为 **medium**（代码结构只证明"接口形状"，不证明"此处出过问题"）。

### evidence_inventory 更新规则

- 实际读到的路由/模型/前端结构 → 从 `not_inspected` 移到 `available`
- 测试源文件 → 始终留在 `not_inspected`

---

## Step 4 — LLM 合成（改：code-derived evidence）

### 追加的 LLM 规则

11. 当 `evidence[]` 包含 `source: "source_code"` 的项时，可据此产出 hotspots/watchlist，但置信度不超过 `medium`。
12. 纯代码 evidence 产出的 case_design_guidance（`priority_hints`, `suggested_scenarios`, `regression_focus`）可以填充，但必须在每项注明 `source_basis: "code_structure_only"`。
13. `executive_summary` 需明确标注数据来源（"来自代码结构分析；无历史执行数据"）。

---

## Step 5 — 一次一问追问 open_questions（新增）

### 流程

1. LLM 合成草稿后，检查 `open_questions_for_case_design[]` 是否非空。
2. 若为空 → 跳过追问，直接进 Step 6。
3. 若非空 → 按顺序一次展示一个问题：

```
探索发现一个需要确认的问题 (1/N)：

<question 文本>

<若有 options，展示为可选项>

请回答，或输入"跳过"（此问题将留给 case-design 阶段）。
```

4. 用户回答 → 写入对应 `open_questions[i].answer`，`answered_via = "explore"`
5. 用户输入"跳过" → `answer = null`，`answered_via = null`
6. 全部问完 → 进入 Step 6

### 停止条件

若用户连续跳过 3 个，输出提示："剩余问题将由 case-design 阶段处理。" 并跳出循环。

---

## open_questions schema 扩展

**文件**: `schemas/explore-advisory.schema.json`

在 `open_questions_for_case_design` 的每个 item 中增加两个可选字段：

```json
{
  "id": "OQ-001",
  "question": "...",
  "maps_to_clarifying_categories": ["module_confirmation"],
  "options": [...],
  "answer": "用户回答文本 | null",
  "answered_via": "explore | null"
}
```

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `answer` | string \| null | null | explore 阶段收集的用户回答 |
| `answered_via` | `"explore"` \| null | null | 标记答案来源 |

---

## case-design 去重消费（aws-case-design/SKILL.md）

### Checklist Step 0（改）

读 `explore/advisory.json` 时：
- 收集 `open_questions_for_case_design[]` 中 `answer != null` 的项 → 视为已澄清，不重复追问
- `answer == null` 的项 → 合并进 Step 4 一次一问澄清流程，与 8 类类别去重

### Step 4 澄清策略补充

> 若 advisory 存在已答 open_questions，先在内部把答案视同用户已提供的澄清上下文，无需再对用户重申。仅对 `answer == null` 的 open_questions 项，在对应类别未覆盖时补问。

### proposal.md `## Explore Input` 段落（改）

```markdown
## Explore Input
advisory: explore/advisory.json (status: done | degraded)
已答问题: OQ-001 (module_confirmation), OQ-003 (data_needs)
未答问题: OQ-002 (exception_scenarios) → 在本阶段澄清
adopted: [...]
override: [...]
gap: [...]
```

---

## 不变的部分

- `aws risk context` CLI 行为、`context_builder.ts` 不改
- case.yaml 边界不变（仍不持久化 advisory 元数据）
- hotspot/watchlist 仍要求 `evidence_ids[]`（code-derived evidence 有 ID，合规）
- `aws risk validate-advisory` 校验仍在 Step 6 执行

---

## 影响文件清单

| 文件 | 变更类型 |
|------|----------|
| `skills/aws-explore/SKILL.md` | 改：新增 Step 2/3/5，改弱数据门，改 LLM 规则 |
| `schemas/explore-advisory.schema.json` | 改：open_questions item 加 answer/answered_via |
| `skills/aws-case-design/SKILL.md` | 改：Step 0/4 增加 open_questions 去重逻辑，改 Explore Input 段落 |
| `skills/aws-workflow/SKILL.md` | 改：Phase 1.1 描述更新（explore 现为半交互） |

---

## 未涉及的问题（有意不改）

- `aws-author.md` 权限：源码为只读（Read/Grep），不涉及写权限
- `explore-context.schema.json`：CLI 产出结构不变
- 置信度等级枚举：不新增，code-derived 只是限制上限 medium
