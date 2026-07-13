# QA Proposal — 菜单管理模块

**change_id**: `eval-sample-003`
**module**: `menus`
**created**: 2026-06-14
**status**: in_progress (Phase 1 — Case Design)

---

## 1. 背景

vue-fastapi-admin 是基于 FastAPI + Vue3 + Naive UI 的 RBAC 后台管理系统。菜单管理模块承载动态路由与权限树维护。本次 QA 任务对该模块进行**全量覆盖**，建立 API + E2E 自动化测试基线。

## 2. 测试目标

- 验证菜单管理 API 端到端功能正确性（树形 CRUD）。
- 验证前端 `/system/menu` 页面与后端契约一致，关键交互可用。
- 覆盖删除带子节点拒绝、update 需完整 payload 等已知约束。

## 3. 范围

### 3.1 In Scope

#### API 端点

| Endpoint | Method | 覆盖点 |
|---|---|---|
| `/api/v1/menus/list` | GET | 树形列表、分页、未授权 401 |
| `/api/v1/menus/get` | GET | 正常获取、不存在 menu_id |
| `/api/v1/menus/create` | POST | 根菜单/子菜单创建 |
| `/api/v1/menus/update` | POST | 正常更新（需完整 component 等字段） |
| `/api/v1/menus/delete` | DELETE | 叶子删除成功、有子节点 business 4000 |

#### E2E 用户场景（`/system/menu` 页面）

1. 管理员登录 → 进入菜单管理页 → 树形列表加载。
2. 新建根菜单 → 提交 → 树中出现新节点。
3. 新建子菜单 → 提交 → 父节点下出现子节点。
4. 编辑菜单 → 保存 → 树反映变更。
5. 删除叶子菜单 → 确认 → 节点消失。
6. 尝试删除有子节点的菜单 → 提示失败。

### 3.2 Out of Scope

- 角色授权绑定（role 模块 change）。
- 用户 / 部门 / API 管理模块 CRUD。
- 循环 parent_id 异常（已知产品缺陷，仅记录不回归）。

## 4. 测试类型与策略

| 类型 | 框架 | 用例数（预估） | 覆盖目标 |
|---|---|---|---|
| API | pytest + httpx | 14 | 端点契约、树形结构、删除约束 |
| E2E | Python Playwright | 6 | 关键菜单管理旅程 |

## 5. 关键风险与已知约束

- **delete 参数名**：使用 `id` 而非 `menu_id`。
- **update 无 component 默认值**：必须 echo 完整 payload，推荐使用 read_then_update helper。
- **删除有子节点**：HTTP 200 + business code 4000。

## 6. 通过准则（Done Definition）

- 全部 case 在执行阶段 PASS。
- case review gate `decision = pass`。
- 测试代码落在 `tests/api/test_menu_api.py` 与 `tests/e2e/test_menu_management_e2e.py`。
