# Proposal: 20260614-menu-mgmt

## Why

菜单管理模块是 RBAC 权限体系的入口资源（动态路由、按钮级权限均依赖菜单树）。当前模块缺少自动化 QA 资产 — `qa/cases/menu/` 与 `tests/api`、`tests/e2e` 中均无菜单相关用例。本次变更建立菜单模块的初版 Case 资产，重点覆盖**树结构构建、order 排序、循环依赖防护**三个高风险面。

## Test Basis

- Requirement ID: REQ-MENU-MGMT
- Feature Name: menu-management
- Source: 项目内置功能（`app/api/v1/menus/menus.py` + `app/models/admin.py:Menu`），首次 QA 初始化
- Target Module: `menu`
- Target Case File: `qa/cases/menu/case.yaml`

## What to Test

- 菜单 CRUD (create / get / list / update / delete) 的最小响应级行为
- 多层级菜单树通过 `parent_id` + `order` 字段构建后的递归列表正确性
- order 字段控制同级菜单顺序的可观察行为
- 修改 `parent_id` 实现菜单跨父节点移动
- 删除有子菜单时业务失败（项目内置规则：`Cannot delete a menu with child menus`）
- **循环依赖防护**：将菜单的 `parent_id` 设置为自身或其后代时是否被拒绝（当前实现疑似无防护，预期此 case 可能暴露产品缺陷）

## Out of Scope

- RBAC 角色 × 菜单授权矩阵（属于 role 模块）
- 菜单图标渲染、icon 字段视觉验证
- 前端动态路由生成、按钮级权限指令
- 性能 / 压力 / 并发写测试
- 菜单 keepalive / redirect 字段的运行时行为（仅写入校验，不验证浏览器侧效果）
- 多用户并发编辑同一菜单的乐观锁/冲突处理

## Confirmed Coverage Approach

选择 **方案 B：API + E2E（10 个 case）**，分层依据：

- **API 层（8 个 case）** 覆盖单请求可观察行为 — CRUD 正常路径 + 业务规则（删除拒绝）+ 高风险负面路径（循环依赖）。错误码矩阵全部归属 API。
- **E2E 层（2 个 case）** 覆盖必须依赖浏览器多步交互 + 列表实时刷新的关键用户流：1 个 happy path（新增后立即可见）、1 个关键异常（删除被拒绝时 UI 反馈）。

不选择方案 A（5 个 case）因为它放弃了循环依赖、移动节点、删除叶子 3 个核心覆盖点；不选择方案 C（15+ case）因为 order 边界、多层深度、并发等场景与当前 focus（tree/sort + 循环依赖）相比边际收益低。

## Test Conditions

| Condition ID | Condition | Source | Priority | Risk Level | Design Technique |
|---|---|---|---|---|---|
| COND-MENU-001 | 验证可创建顶级目录菜单（parent_id=0） | REQ-MENU-MGMT | P0 | high | use_case |
| COND-MENU-002 | 验证可在已存在父菜单下创建子菜单 | REQ-MENU-MGMT | P0 | high | use_case |
| COND-MENU-003 | 验证列表接口返回的菜单树按 order 升序、按 parent_id 嵌套 | REQ-MENU-MGMT | P0 | high | use_case |
| COND-MENU-004 | 验证可修改菜单基础字段并持久化 | REQ-MENU-MGMT | P1 | medium | use_case |
| COND-MENU-005 | 验证修改 parent_id 可将菜单移动到新父节点 | REQ-MENU-MGMT | P1 | high | state_transition |
| COND-MENU-006 | 验证删除有子菜单的菜单时返回业务失败 | REQ-MENU-MGMT | P0 | high | negative |
| COND-MENU-007 | 验证可删除叶子菜单 | REQ-MENU-MGMT | P1 | medium | use_case |
| COND-MENU-008 | 验证将菜单 parent_id 设置为自身或其后代时被拒绝（防止树成环） | REQ-MENU-MGMT | P0 | critical | negative |
| COND-MENU-E2E-001 | 验证在菜单管理页面创建顶级目录后列表立即刷新可见 | REQ-MENU-MGMT | P0 | high | use_case |
| COND-MENU-E2E-002 | 验证在 UI 删除有子菜单的菜单时拒绝并保留节点 | REQ-MENU-MGMT | P1 | medium | negative |

## Quality Risks

| Risk | Likelihood | Impact | Level | Mitigation |
|---|---|---|---|---|
| `update` 允许把 `parent_id` 设为自身或后代 → `/list` 递归无限循环导致服务挂死 | 4 | 5 | critical | TC-MENU-008 显式覆盖；若 case 失败按 product issue 流转 |
| 有子菜单的菜单被错误删除 | 3 | 3 | medium | TC-MENU-006 验证业务拒绝 |
| 同级菜单 order 相同时顺序未定义 | 4 | 2 | medium | TC-MENU-003 用不同 order 值确认升序；不验证相同 order 的稳定性 |
| 多层级递归构建树深度边界 | 2 | 3 | low | TC-MENU-003 至少验证 2 层嵌套；更深层不展开 |
| 创建/修改后前端列表不刷新 | 3 | 4 | high | TC-MENU-E2E-001 验证 |

## Test Types

- API
- E2E

## Layer Rationale

For each case in this change, record the layer assignment and rationale.

- TC-MENU-001: API
  - reason: 单请求 + 响应断言可覆盖 — 创建后通过 list 或 get 接口的响应字段验证持久化，不依赖 UI。
- TC-MENU-002: API
  - reason: 单请求 + 列表接口响应即可断言子菜单挂载关系，无需浏览器交互。
- TC-MENU-003: API
  - reason: list 接口直接返回嵌套树，断言 order 升序与 parent_id 嵌套属于响应体校验，不需要 UI。
- TC-MENU-004: API
  - reason: update 后通过 get 接口断言字段已变更，单请求行为，不需要 UI。
- TC-MENU-005: API
  - reason: 状态迁移（parent_id 变更）可通过两次 list/get 调用观测，单层 API 即可覆盖。
- TC-MENU-006: API
  - reason: 业务失败响应（msg 包含 "Cannot delete a menu with child menus"）属于响应体断言，错误码矩阵归 API。
- TC-MENU-007: API
  - reason: delete 后 get 返回 404 / 业务失败，单请求即可断言。
- TC-MENU-008: API
  - reason: 循环依赖防护是后端业务规则，应在 API 层直接验证，避免 UI 不稳定影响。
- TC-MENU-E2E-001: E2E
  - reason: 必须验证「创建表单提交后菜单列表 UI 刷新且新节点可见」的浏览器侧行为，超出单请求断言能力。
- TC-MENU-E2E-002: E2E
  - reason: 必须验证「失败时 UI 错误提示出现 + 节点仍保留在树中」的多步浏览器交互。

## Data Needs

- **认证 fixture**：复用现有 admin 用户（默认 `admin / 123456`，由全局 conftest 提供 access_token）
- **菜单树结构 fixture**：单 case 内自创建 + 测试结束清理，避免污染全局 menu 表
  - `top_level_menu_factory(name, order)` — 创建顶级目录
  - `child_menu_factory(parent_id, name, order)` — 创建子菜单
  - `menu_with_children_factory()` — 创建一个父菜单 + 至少 2 个子菜单
- **数据清理**：每个 case 用例后通过 delete 接口清理自建菜单；若 delete 失败（TC-MENU-006 场景）需在 teardown 中先删子后删父
- **out-of-band 清理兜底**：fixture 失败时通过 `Menu.filter(name__startswith="qa-test-")` 直接 ORM 删除（`.aws/data-knowledge.yaml` 中应已注册此能力，由 fact_baseline 阶段确认）

## Success Assertions

- 创建/修改/删除接口返回 HTTP 200 + 业务码 200 + 期望 msg
- list 接口返回的菜单树满足 parent_id 嵌套关系
- list 接口同级菜单按 order 字段升序排列
- 删除有子菜单时返回 HTTP 200 但业务失败（msg 含 "Cannot delete"）
- 循环依赖请求被拒绝（具体响应形式由实现决定：业务失败 / HTTP 4xx / 字段校验错误均可，case 在 assertion 中描述「不允许成环」）
- E2E 创建后列表 UI 出现新节点；E2E 删除被拒后节点仍存在 + 错误反馈可见

## Exception Scenarios

**已纳入：**
- TC-MENU-006: 删除有子菜单（业务失败）
- TC-MENU-008: 循环依赖防护

**已排除（本次不覆盖）：**
- 未登录调用菜单接口（属 auth 模块覆盖范围）
- 重复 path 创建（项目无唯一约束，行为未定义）
- 超长 name / 非法 path 字符（属字段校验通用模式）
- 并发删除同一菜单
- order 字段为负数 / 极大值（boundary value，属方案 C）

## Entry Criteria

- 后端 `python run.py` 可启动，`/api/v1/menus/*` 端点可调用
- 数据库可连接，Menu 表存在
- 默认 admin 用户存在（系统初始化时由 `app/core/init_app.py` 写入）
- 前端 `pnpm dev` 可启动，`/system/menu` 路由可访问

## Exit Criteria for This Phase

- `proposal.md` 已写入
- `cases/menu/case.yaml` 已生成并通过 self-review
- 每个 case 都可追溯到 `requirement_id` + `test_condition_id`
- 所需 automation target 已识别（API / E2E）
- 准备进入 aws-case-reviewer

## Downstream Exit Criteria

- case review 通过后，aws-api-plan / aws-e2e-plan 生成 `plans/*.md`
- codegen + run 后由 aws-archive 更新 traceability matrix
