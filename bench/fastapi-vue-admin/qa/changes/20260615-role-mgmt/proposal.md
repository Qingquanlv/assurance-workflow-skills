# Proposal: 20260615-role-mgmt

## Why

角色（Role）是 RBAC 三元组（用户 / 角色 / 权限）中的中介实体，承担「把菜单可见性 + API 调用权限批量授予一组用户」的职责。当前模块尚未沉淀自动化 QA 资产 — `qa/cases/roles/` 不存在，`tests/api` 与 `tests/e2e` 中也没有角色相关用例。本次变更建立角色模块的初版 Case 资产，重点覆盖三个面：

1. **角色 CRUD** — 列表 / 详情 / 创建 / 更新 / 删除，构成基础闭环。
2. **权限绑定（核心高风险面）** — `POST /api/v1/role/authorized` 调用 `RoleController.update_roles()`，先 `clear()` 再 `add()`：必须验证「重写而非追加」，否则会演化为权限蠕变。
3. **角色名唯一性** — `POST /api/v1/role/create` 在创建时通过 `is_exist(name=...)` 显式校验同名，需要回归保护。

## Test Basis

- Requirement ID: REQ-ROLE-MGMT
- Feature Name: role-management
- Source: 项目内置功能（`app/api/v1/roles/roles.py` + `app/controllers/role.py` + `app/schemas/roles.py` + `app/models/admin.py:Role`），首次 QA 初始化
- Target Module: `roles`
- Target Case File: `qa/cases/roles/case.yaml`
- Endpoints under test:
  - `GET  /api/v1/role/list`
  - `GET  /api/v1/role/get`
  - `POST /api/v1/role/create`
  - `POST /api/v1/role/update`
  - `DELETE /api/v1/role/delete`
  - `GET  /api/v1/role/authorized`
  - `POST /api/v1/role/authorized`

## What to Test

- 角色列表分页与按 `name` 模糊搜索的可观察行为
- 按 ID 查询角色详情
- 创建角色 happy path（唯一 name + desc）
- 创建角色时使用已存在的 name 应被拒绝（业务错误）
- 更新角色基础字段（desc）持久化
- 删除角色后该角色从数据库消失
- `GET /authorized` 回显角色当前绑定的 menus / apis
- `POST /authorized` 重写绑定：传入 `menu_ids=[B]` 后，原本 `menus=[A]` 必须只剩 `[B]`（非追加）
- `POST /authorized` 同时重写 `apis`：传入 `api_infos=[{path,method}]` 后旧 API 绑定被替换
- E2E：管理员可在角色管理页加载列表
- E2E：管理员可在 UI 创建新角色并立即在列表可见
- E2E：管理员可在 UI 通过权限弹窗为角色勾选菜单并保存，再次打开仍回显
- Fuzz：schemathesis 对全部 7 个 `/api/v1/role/*` 端点做 schema-based 健壮性扫描

## Out of Scope

- 更新角色时改 name 为已存在 name 的冲突处理（当前实现路径未做校验，属产品规则未明确，本次不验证不暴露）
- 删除已绑定到用户的角色的级联行为（属 user 模块语义）
- 删除内置 admin 角色 / 改 admin 角色名 的保护（产品未声明保护规则，本次不强制）
- 前端按钮级 ACL 指令（`v-permission`）在不同角色身份下的可见性切换（属下游 RBAC 端到端流，不在本初版范围）
- 性能 / 并发 / 大量绑定（>1k menus）的压力面
- 角色绑定不存在的 menu_id / api(path,method) 时的具体响应形态（实现走 `Menu.filter().first()` 返回 None 后 `add(None)` 会抛错，行为未定义；本次仅在 fuzz 层暴露，不在 functional case 中断言）

## Confirmed Coverage Approach

选择 **方案 B：API + E2E + Fuzz（API 11 + E2E 3 + Fuzz 1 = 15 个 case）**，分层依据：

- **API 层（11 个 case）** 覆盖单请求可观察行为 — CRUD 全部正常路径 + 唯一性校验负面路径 + 权限绑定的「重写而非追加」核心断言。错误响应矩阵全部归 API。
- **E2E 层（3 个 case）** 覆盖必须依赖浏览器多步交互的关键用户流：1 个页面加载 happy path + 1 个新建角色后列表刷新 + 1 个权限弹窗多选保存与回显（最高 UI 风险点）。
- **Fuzz 层（1 个 case）** 用 schemathesis 在 OpenAPI schema 之上对全部 7 个角色端点做 schema-based 健壮性扫描，覆盖必填字段缺失、类型反转、超长字符串、空数组、负数 ID 等组合面。

不选择「仅 API + E2E」因为放弃 fuzz 会错过 `RoleUpdateMenusApis` 中 `api_infos: list[dict]` 这种弱类型 schema 在异常输入下的崩溃面（用户明确选择 Full 全栈）。
不选择「逐字段 boundary」（25+ case）因为绝大多数边界由 fuzz 自动覆盖。

## Test Conditions

| Condition ID | Condition | Source | Priority | Risk Level | Design Technique |
|---|---|---|---|---|---|
| COND-ROLE-001 | 验证管理员按默认分页参数获取角色列表 | REQ-ROLE-MGMT | P0 | high | use_case |
| COND-ROLE-002 | 验证按 name 模糊搜索角色列表只返回匹配项 | REQ-ROLE-MGMT | P1 | medium | equivalence_partitioning |
| COND-ROLE-003 | 验证按 ID 查询角色详情正确返回 | REQ-ROLE-MGMT | P0 | high | use_case |
| COND-ROLE-004 | 验证按不存在 ID 查询角色详情时返回错误 | REQ-ROLE-MGMT | P1 | medium | error_guessing |
| COND-ROLE-005 | 验证创建唯一 name 的新角色成功 | REQ-ROLE-MGMT | P0 | high | use_case |
| COND-ROLE-006 | 验证创建已存在 name 的角色返回业务错误 | REQ-ROLE-MGMT | P0 | high | error_guessing |
| COND-ROLE-007 | 验证更新角色 desc 字段持久化 | REQ-ROLE-MGMT | P1 | medium | use_case |
| COND-ROLE-008 | 验证删除角色后数据库不再存在该角色 | REQ-ROLE-MGMT | P0 | high | use_case |
| COND-ROLE-009 | 验证 GET /authorized 返回角色当前 menus / apis 绑定 | REQ-ROLE-MGMT | P0 | high | use_case |
| COND-ROLE-010 | 验证 POST /authorized 重写 menu_ids（旧绑定被清除，新绑定生效） | REQ-ROLE-MGMT | P0 | critical | state_transition |
| COND-ROLE-011 | 验证 POST /authorized 重写 api_infos（旧 API 绑定被清除，新绑定生效） | REQ-ROLE-MGMT | P0 | critical | state_transition |
| COND-ROLE-E2E-001 | 验证管理员登录后可进入角色管理页且看到角色列表 | REQ-ROLE-MGMT | P0 | high | use_case |
| COND-ROLE-E2E-002 | 验证管理员通过 UI 创建新角色后列表立即刷新可见 | REQ-ROLE-MGMT | P0 | high | use_case |
| COND-ROLE-E2E-003 | 验证管理员在权限弹窗为角色勾选菜单后保存，再次打开仍回显 | REQ-ROLE-MGMT | P1 | high | use_case |
| COND-ROLE-FUZZ-001 | 验证全部 7 个 /api/v1/role/* 端点对 schema-based 异常输入不崩溃 | REQ-ROLE-MGMT | P1 | high | fuzz |

## Quality Risks

| Risk | Likelihood | Impact | Level | Mitigation |
|---|---|---|---|---|
| `update_roles` 的 clear+add 顺序在异常时只清除未重写 → 角色权限被静默清空 | 3 | 5 | critical | TC-ROLE-010 / TC-ROLE-011 显式断言「旧绑定不再存在 + 新绑定生效」 |
| 创建同名角色绕过校验 → 数据完整性损坏 | 2 | 4 | high | TC-ROLE-006 显式覆盖业务错误返回 |
| GET /authorized 漏字段（缺 apis 或 menus）→ 前端权限弹窗回显错位 | 3 | 3 | medium | TC-ROLE-009 断言响应同时包含 menus 与 apis |
| 列表分页字段（page / page_size / total）回归 → 前端分页控件失效 | 2 | 3 | medium | TC-ROLE-001 断言分页字段与请求一致 |
| 权限绑定的 API 通过 (path, method) 寻址 → 异常 path/method 写入导致 add(None) 崩溃 | 3 | 2 | medium | TC-ROLE-FUZZ-001 在 fuzz 层暴露，不在 functional case 中断言具体响应形态 |
| E2E 角色权限弹窗在保存后不回显 → 管理员误以为未生效再次保存导致权限重写 | 3 | 4 | high | TC-ROLE-E2E-003 断言再次打开时勾选状态保持 |

## Test Types

- API
- E2E
- Fuzz

## Layer Rationale

- TC-ROLE-001（list 默认分页）: API — 单请求 + 响应字段断言，无需 UI。
- TC-ROLE-002（按 name 模糊搜索）: API — 查询参数 + 响应过滤断言，单请求。
- TC-ROLE-003（按 ID 详情）: API — 单请求响应断言。
- TC-ROLE-004（不存在 ID）: API — 错误响应断言归 API 错误码矩阵。
- TC-ROLE-005（create 成功）: API — 创建后通过 ORM 或 list 接口断言存在，单请求行为。
- TC-ROLE-006（create 重复 name）: API — 业务错误响应断言归 API。
- TC-ROLE-007（update desc）: API — 单请求 + ORM 校验持久化。
- TC-ROLE-008（delete 成功）: API — 单请求 + ORM 校验消失。
- TC-ROLE-009（GET /authorized 回显）: API — 响应字段断言。
- TC-ROLE-010（POST /authorized 重写 menus）: API — 状态迁移可通过两次 GET /authorized 调用观测；状态迁移核心断言归 API，避免 UI 抖动干扰。
- TC-ROLE-011（POST /authorized 重写 apis）: API — 同上，权限边界必须在 API 层有保护。
- TC-ROLE-E2E-001（角色管理页加载）: E2E — 必须验证 UI 路由 + 表格渲染，超出单请求断言能力。
- TC-ROLE-E2E-002（UI 创建后列表刷新）: E2E — 必须验证「表单提交后列表 UI 刷新」的浏览器侧多步行为。
- TC-ROLE-E2E-003（权限弹窗勾选保存与回显）: E2E — 必须验证多选控件、Tab 切换、保存按钮、再次打开时勾选回显的完整 UI 闭环。
- TC-ROLE-FUZZ-001（schema-based 健壮性）: Fuzz — schemathesis 自动从 OpenAPI 抽取参数空间，覆盖人工 case 覆盖不到的组合面。

## Data Needs

- **认证 fixture**：复用 admin 用户（默认 `admin / 123456`），由全局 `tests/api/conftest.py` 与 `tests/e2e/conftest.py` 提供 access_token / 已登录 page。
- **角色 fixture（自创建 + 自清理）**：
  - `role_factory(name_prefix="qa-role-", desc=...)` — 创建唯一名角色并返回 id
  - `role_with_menus_factory(menu_ids=[...])` — 创建角色后通过 POST /authorized 绑定一组 menus
  - `role_with_apis_factory(api_infos=[{path,method}])` — 创建角色后绑定一组 apis
- **菜单 / API 引用 fixture**：
  - `seeded_menu_ids` — 从默认初始化的菜单中读取 2 个稳定 ID（在 fact baseline 阶段确认）
  - `seeded_api_endpoints` — 从默认初始化的 Api 表中读取 2 条 (path, method)（在 fact baseline 阶段确认）
- **out-of-band 清理兜底**：`Role.filter(name__startswith="qa-role-")` 在 fixture teardown 失败时直接 ORM 删除（`.aws/data-knowledge.yaml` 应已注册此能力，由 fact_baseline 阶段确认）。
- **fuzz 数据**：schemathesis 直接从 `/api/v1/openapi.json` 拉取 schema，无需手工准备样本；只需在 fuzz fixture 中提供已认证的 base_url + headers。

## Success Assertions

- list / get / authorized 接口返回 HTTP 200 + 业务 code 200 + 期望 data 结构
- create 接口对唯一 name 返回成功；对重复 name 返回业务错误（HTTP 4xx 或 业务码非 200，msg 含 "already exists"）
- update 接口返回成功后通过 ORM 查询字段已变更
- delete 接口返回成功后通过 ORM 查询不到该角色
- POST /authorized 后立即调用 GET /authorized：menus / apis 仅包含本次入参（旧绑定不存在）
- E2E：页面加载断言 URL + 表格至少 1 行；新建后断言 toast + 列表搜索可见；权限弹窗断言再次打开时勾选保持
- Fuzz：schemathesis 报告 0 个 server_error（5xx）、0 个 schema_violation；其它发现以 product issue 形式记录但不阻断 case 通过

## Exception Scenarios

**已纳入：**
- TC-ROLE-004：按不存在 ID 查询返回错误
- TC-ROLE-006：创建已存在 name 返回业务错误

**已排除（本次不覆盖）：**
- 更新角色 name 改为另一已存在 name 的冲突（产品未实现校验）
- 删除已分配给用户的角色（属 user 模块语义）
- 删除内置 admin 角色 / 改名 admin（产品未声明保护规则）
- 未携带凭证调用角色接口（auth 模块覆盖）
- 并发删除同一角色

## Entry Criteria

- 后端 `python run.py` 可启动，`/api/v1/role/*` 端点可调用
- 数据库可连接，`Role` / `Menu` / `Api` 表存在，至少 1 条 menu + 1 条 api 已在 init_app 阶段写入
- 默认 admin 用户存在
- 前端 `pnpm dev` 可启动，`/system/role` 路由可访问
- `/api/v1/openapi.json` 可被 schemathesis 抓取

## Exit Criteria for This Phase

- `proposal.md` 已写入
- `cases/roles/case.yaml` 已生成（API 11 + E2E 3 + Fuzz 1 = 15 cases）
- 每个 case 都可追溯到 `requirement_id` + `test_condition_id`
- 每个 case 已识别 automation target（API / E2E / Fuzz）
- 准备进入 `aws-case-reviewer`

## Downstream Exit Criteria

- case review 通过后，`aws-api-plan` / `aws-e2e-plan` / `aws-fuzz-plan` 生成各自 plan
- plan review 通过后进入 codegen 三层
- `aws run` 后由 `aws-archive` 更新 traceability matrix（gated，需要用户确认 — `auto_archive=false`）
