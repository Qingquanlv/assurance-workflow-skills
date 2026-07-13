# QA Proposal — 角色管理模块

**change_id**: `eval-sample-002`
**module**: `roles`
**created**: 2026-06-15
**status**: in_progress (Phase 1 — Case Design)

---

## 1. 背景

vue-fastapi-admin 是基于 FastAPI + Vue3 + Naive UI 的 RBAC 后台管理系统。角色管理模块承载 RBAC 核心实体维护与菜单/API 授权绑定。本次 QA 任务对该模块进行**全量覆盖**，建立 API + E2E 自动化测试基线。

## 2. 测试目标

- 验证角色管理 API 端到端功能正确性（CRUD + 授权绑定）。
- 验证前端 `/system/role` 页面与后端契约一致，关键交互可用。
- 建立可重复执行的回归测试集，作为后续角色模块变更的安全网。

## 3. 范围

### 3.1 In Scope

#### API 端点

| Endpoint | Method | 覆盖点 |
|---|---|---|
| `/api/v1/role/list` | GET | 默认分页、按 role_name 模糊、未授权 401 |
| `/api/v1/role/get` | GET | 正常获取、不存在 ID |
| `/api/v1/role/create` | POST | 正常创建、名称重复 400 |
| `/api/v1/role/update` | POST | 正常更新、不存在 ID |
| `/api/v1/role/delete` | DELETE | 正常删除、不存在 ID |
| `/api/v1/role/authorized` | GET/POST | 查询/更新菜单与 API 绑定（clear+add 语义） |

#### E2E 用户场景（`/system/role` 页面）

1. 管理员登录 → 进入角色管理页 → 列表加载。
2. 新建角色 → 提交 → 列表出现新角色。
3. 编辑角色 → 保存 → 列表反映变更。
4. 配置角色菜单/API 授权 → 保存 → 重新打开确认绑定保留。
5. 删除角色 → 确认 → 列表中消失。

### 3.2 Out of Scope

- 用户模块本身的 CRUD 与角色分配（独立 change）。
- 菜单 / 部门 / API 管理模块自身的 CRUD。
- 前端样式视觉回归。

## 4. 测试类型与策略

| 类型 | 框架 | 用例数（预估） | 覆盖目标 |
|---|---|---|---|
| API | pytest + httpx | 12 | 端点契约、参数校验、权限边界 |
| E2E | Python Playwright | 5 | 关键角色管理旅程 |

## 5. 关键风险与已知约束

- **授权绑定 clear+add**：`POST /role/authorized` 会先清空再写入，测试需断言最终绑定状态而非增量 patch。
- **角色名唯一性**：create 路径 duplicate name 返回 HTTP 400。
- **seed 角色**：init_app 预置「管理员」「普通用户」，E2E 授权测试需选用稳定 seed 菜单。

## 6. 通过准则（Done Definition）

- 全部 case 在执行阶段 PASS。
- case review gate `decision = pass`。
- 测试代码落在 `tests/api/test_role_api.py` 与 `tests/e2e/test_role_management_e2e.py`。
