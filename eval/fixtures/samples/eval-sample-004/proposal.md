# QA Proposal — 部门管理模块

**change_id**: `eval-sample-004`
**module**: `depts`
**created**: 2026-06-14
**status**: in_progress (Phase 1 — Case Design)

---

## 1. 背景

vue-fastapi-admin 是基于 FastAPI + Vue3 + Naive UI 的 RBAC 后台管理系统。部门管理模块承载组织架构树维护，与用户 dept_id 关联。本次 QA 任务对该模块进行**全量覆盖**，建立 API + E2E 自动化测试基线。

## 2. 测试目标

- 验证部门管理 API 端到端功能正确性（树形 CRUD）。
- 验证前端 `/system/dept` 页面与后端契约一致，关键交互可用。
- 建立可重复执行的回归测试集。

## 3. 范围

### 3.1 In Scope

#### API 端点

| Endpoint | Method | 覆盖点 |
|---|---|---|
| `/api/v1/dept/list` | GET | 树形列表、按 name 搜索、未授权 401 |
| `/api/v1/dept/get` | GET | 正常获取、不存在 id |
| `/api/v1/dept/create` | POST | 根部门/子部门创建 |
| `/api/v1/dept/update` | POST | 正常更新、不存在 id |
| `/api/v1/dept/delete` | DELETE | 正常删除、不存在 id、delete 参数 dept_id |

#### E2E 用户场景（`/system/dept` 页面）

1. 管理员登录 → 进入部门管理页 → 树形列表加载。
2. 新建根部门 → 提交 → 树中出现新节点。
3. 新建子部门 → 提交 → 父节点下出现子节点。
4. 编辑部门 → 保存 → 树反映变更。
5. 删除部门 → 确认 → 节点消失。

### 3.2 Out of Scope

- 用户模块 dept_id 关联回归（user change 覆盖）。
- 角色 / 菜单 / API 管理模块 CRUD。
- 前端样式视觉回归。

## 4. 测试类型与策略

| 类型 | 框架 | 用例数（预估） | 覆盖目标 |
|---|---|---|---|
| API | pytest + httpx | 12 | 端点契约、树形结构、权限边界 |
| E2E | Python Playwright | 5 | 关键部门管理旅程 |

## 5. 关键风险与已知约束

- **delete 参数名**：使用 `dept_id` 而非 `id`。
- **name 长度**：ORM 层 max_length=20，Pydantic schema 未显式约束。
- **树形结构**：list 返回嵌套 children，测试需递归断言或 flat 辅助。

## 6. 通过准则（Done Definition）

- 全部 case 在执行阶段 PASS。
- case review gate `decision = pass`。
- 测试代码落在 `tests/api/test_dept_api.py` 与 `tests/e2e/test_dept_management_e2e.py`。
