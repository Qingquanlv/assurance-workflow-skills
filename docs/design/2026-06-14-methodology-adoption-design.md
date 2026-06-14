# 测试方法论吸收设计(阶段一:C1 + C4)

> 状态:已批准方向,待实现
> 日期:2026-06-14
> 来源:吸收 [addyosmani/test-engineer](https://github.com/addyosmani/agent-skills/blob/main/agents/test-engineer.md) 与 [stvlynn/agentic-coding](https://github.com/stvlynn/agentic-coding/tree/main/docs/quality) 的测试方法论

## 1. 背景与目标

当前项目(AWS — Assurance Workflow Skills)是一台「QA 执法机器」:强在流程约束(DAG + 确定性 gate),弱在测试方法论的显式表达。两个外部项目各补一块短板:

- **addyosmani/test-engineer**:测试分层决策树 + Prove-It 模式(方法论)
- **stvlynn/agentic-coding**:code review checklist + "fail for the right reason" + factory 数据原则(质量门禁)

**目标**:把这些方法论固化成项目里可执行/可约束的 skill 规则,而不是停留在文档建议。

**总原则**:不破坏现有 DAG / gate / DSL 架构。所有新增都以「现有 skill 规则增量」或「现有 reviewer 的新检查类别」形式接入,不引入新的重型阶段、不改 `case.yaml` 与 `workflow-schema.yaml` 的 schema。

## 2. 范围

本阶段只做:

- **C1 — 测试分层决策树**
- **C4 — 测试数据原则澄清**

明确**不做**(后续阶段评估):

- C2 — Prove-It 模式(涉及 healing loop 状态机「留红测试 vs 真失败」的区分,需谨慎设计)
- C3 — 测试代码 review gate(最重,需新增 phase + gate)

## 3. C1 — 测试分层决策树

落到三个 skill,不动 `case.yaml` schema。

### 3.1 `aws-case-design`(生产分层依据)

QA 范围澄清环节新增两层决策树(项目只有 API + E2E 两层产物):

```
每条 Case 的验证行为:
├─ 能在「单请求 → 响应断言」层验证 → API 测试 (tests/api/)
│    例:状态码、body、权限码、字段校验、错误码矩阵
└─ 必须验证「浏览器多步操作 + UI 反馈 / 跨页状态」→ E2E 测试 (tests/e2e/)
     例:表单提交后列表实时刷新、确认弹框交互
```

硬规则:

- 能用 API 覆盖的,绝不写成 E2E
- 错误码矩阵放 API
- E2E 只保留 1 条 happy path + 极少数关键异常流

产物变化:

- `proposal.md` 新增 `## Layer Rationale` 一节,逐条 case 标注「API / E2E + 选择理由」。示例:

```markdown
## Layer Rationale

- Case CASE-001 → API
  原因:权限码、状态码、字段校验,单请求即可断言

- Case CASE-002 → E2E
  原因:需要验证前端交互与页面状态同步(提交后列表实时刷新)
```

- `case.yaml` **不变**(不新增 `layer_rationale` 字段,保证零下游影响)。

### 3.2 `aws-case-reviewer`(分层门禁)

- `findings[].category` 枚举新增 `layering`。
- 新增 **Layering Review** 检查项:比对 `proposal.md` 的 `## Layer Rationale` 与各 case 的 `automation_targets`,识别反模式:
  - API 能覆盖却被设计成 E2E
  - 错误码矩阵进入 E2E
  - 整套 CRUD 全流程全部走 E2E
  - 同一验证点同时出现在 API 和 E2E
- 按两类分级,复用现有 severity 门禁(`high`/`critical` 必须人工、不可机器修):

  **Type 1 — 机械可修**(测试目标与验证内容不变,只是层级标错):
  - 例:错误码矩阵 / 字段校验被标成 E2E,应为 API
  - `severity: low | medium`
  - `auto_fix_allowed: true`
  - 修复动作:由 case-fixer 调整 `automation_targets`

  **Type 2 — 设计级**(需拆分 case / 迁移断言 / 重构):
  - 例:一个大 E2E 流程需拆成 API(库存更新)+ E2E(完整下单体验)
  - `severity: high`
  - `auto_fix_allowed: false`
  - `human_review_required: true`
  - 处理:退回 `aws-case-design` / 人工重新设计

  finding 示例(Type 1):

```json
{
  "id": "LAYERING-001",
  "category": "layering",
  "severity": "medium",
  "message": "User permission/error-code matrix should be API, not E2E",
  "auto_fix_allowed": true
}
```

### 3.3 `aws-case-fixer`(机械修分层)

- 对 `category: layering` 且 `auto_fix_allowed: true` 的 finding,**唯一允许**的机械动作:调整 `case.yaml` 的 `automation_targets`(如 `e2e → api` 或 `api → e2e`)。
- 严格继承现有安全规则:`severity in [high, critical]` 直接 STOP,绝不触碰 Type 2 分层问题。
- 不得借分层修复之名改动 case 的标题、断言、范围等语义内容。

## 4. C4 — 测试数据原则澄清

落到 `aws-api-codegen` + `aws-e2e-codegen`,纯规则增量,无产物结构变化。

核心:澄清两个撞名概念。

- **pytest `fixture`** = 依赖注入机制(必须用,是 pytest 惯例)
- **stvlynn 的 `fixture`** = 写死的静态测试数据,他主张用 `factory`(动态生成)替代

新增「测试数据策略」一节:

- 继续用 pytest fixture 作为注入机制(保留现状,`tests/fixtures/` 目录名不变)。
- fixture **内部**应实现为 factory 模式(动态造数 / factory-as-fixture):返回可定制的数据工厂,而非返回写死的静态字典。
- 避免测试间共享可变状态;每个测试拿到独立的数据实例。
- 明确警示:不得因「factory not fixture」原则误删或重命名既有 pytest fixture。

## 5. 涉及文件汇总

| 文件 | 改动 |
|---|---|
| `skills/aws-case-design/SKILL.md` | 决策树规则 + `proposal.md` 加 `## Layer Rationale` |
| `skills/aws-case-reviewer/SKILL.md` | `layering` category + Layering Review + Type1/Type2 分级 |
| `skills/aws-case-fixer/SKILL.md` | 机械修 `automation_targets` 的允许动作边界 |
| `skills/aws-api-codegen/SKILL.md` | 测试数据策略澄清 |
| `skills/aws-e2e-codegen/SKILL.md` | 测试数据策略澄清 |

## 6. 非目标

- 不动 `case.yaml` schema(不加 `layer_rationale` 字段)
- 不动 `workflow-schema.yaml` / 谓词 DSL / 编排引擎
- 不新增 phase 或 gate
- 不碰 healing loop(C2 留待后续)
- 不引入 unit 测试层(项目只有 API + E2E 两层产物)
- 不引入架构 / 安全 review(超出 QA 范围)

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 决策树与现有 `test_types` 选择逻辑打架 | 决策树定位为「`test_types` 已选定后,单条 case 落哪层」的细化,而非替代 |
| Reviewer 误把 Type 2 判成 Type 1,导致 fixer 改坏 case 语义 | 严守 severity 门禁:有疑虑时升级为 `high` + 人工;fixer 仅允许动 `automation_targets` |
| LLM 因 C4 误删 pytest fixture | 在规则里显式区分「机制 fixture」与「数据 factory」,并加警示 |
