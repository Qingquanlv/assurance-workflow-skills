# QA Proposal — 用户管理模块

**change_id**: `20260612-user-mgmt`
**module**: `users`
**created**: 2026-06-12
**status**: in_progress (Phase 1 — Case Design)

---

## 1. 背景

vue-fastapi-admin 是基于 FastAPI + Vue3 + Naive UI 的 RBAC 后台管理系统。用户管理模块是核心 RBAC 功能之一，承载用户主数据维护与角色绑定。本次 QA 任务对该模块进行**全量覆盖**，建立 API + E2E 自动化测试基线。

## 2. 测试目标

- 验证用户管理 API 端到端功能正确性（CRUD + 角色分配 + 密码重置）。
- 验证前端 `/system/user` 页面与后端契约一致，关键交互可用。
- 建立可重复执行的回归测试集，作为后续用户模块变更的安全网。
- 产出 `.aws/data-knowledge.yaml` 之外的 baseline 事实，沉淀模块测试规范。

## 3. 范围

### 3.1 In Scope

#### API 端点（8 个 case，覆盖 6 个 endpoint）

| Endpoint | Method | 覆盖点 |
|---|---|---|
| `/api/v1/user/list` | GET | 默认分页、按 username 模糊、未授权 401 |
| `/api/v1/user/get` | GET | 正常获取、不存在 ID、未授权 |
| `/api/v1/user/create` | POST | 正常创建（含 role_ids）、email 重复 400、缺少必填字段 422 |
| `/api/v1/user/update` | POST | 正常更新（角色重写）、不存在 ID |
| `/api/v1/user/delete` | DELETE | 正常删除、不存在 ID |
| `/api/v1/user/reset_password` | POST | 普通用户重置成功、超级管理员 403、不存在 ID |

#### E2E 用户场景（`/system/user` 页面）

1. 管理员登录 → 进入用户管理页 → 列表加载并显示已存在用户。
2. 新建用户 → 填写表单 → 提交 → 列表出现新用户。
3. 编辑用户 → 修改用户名 → 保存 → 列表反映变更。
4. 给用户分配/取消角色 → 保存 → 重新打开编辑确认角色保留。
5. 删除用户 → 确认弹窗 → 列表中消失。
6. 关键字搜索 → 列表过滤生效。

### 3.2 Out of Scope

- `/api/v1/base/update_password`（自身改密，属于 base 模块）。
- 部门 / 角色 / 菜单 / API 自身的 CRUD（独立 change 处理）。
- 用户头像上传 / 前端样式视觉回归。
- 数据库迁移、初始化脚本。

## 4. 测试类型与策略

| 类型 | 框架 | 用例数（预估） | 覆盖目标 |
|---|---|---|---|
| API | pytest + httpx | 15 | 端点契约、参数校验、权限边界 |
| E2E | Python Playwright (`pytest-playwright`) | 6 | 关键用户旅程、前后端契约 |

> 总计 21 cases，自动化覆盖率 100%。

### 4.1 异常分支深度（standard）

每个 endpoint 1–2 个关键失败分支：
- 鉴权失败（401）—— 至少在 list/get/create 上覆盖一次。
- 业务冲突（400）—— email 重复。
- 资源不存在（404 / business 失败）—— get / update / delete / reset_password。
- 字段校验（422）—— create 缺 email。
- 权限保护（403）—— reset_password 拒绝超级管理员。

### 4.2 数据准备策略（scripts_with_cleanup）

- `qa/changes/20260612-user-mgmt/scripts/seed_users.py`：通过 Tortoise ORM 直接创建 fixture 数据（避免依赖 create API）。
- `tests/helpers/auth.py`：复用现有 admin token 获取逻辑。
- 每个测试函数 setUp 预置 → tearDown 删除自建数据，保证独立性。
- E2E 通过同一 seed 脚本前置数据，避免 UI 流程串行依赖。

## 5. 关键风险与已知约束

- **超级管理员密码重置**：reset_password 对 `is_superuser=True` 用户返回 403，case 必须显式覆盖。
- **角色 m2m 关系**：update_roles 是 `clear() + add()`，每次更新会覆盖原角色；测试需断言 m2m 表最终状态而非 patch 行为。
- **email 唯一性**：仅在 create 路径做了重复检查，update 没有重复检查；不在本次范围内回归此差异。
- **默认数据库**：sqlite 本地文件 `db.sqlite3`，测试需要在 fixture 中保证可写或使用临时 DB。
- **前端**：登录后通过 `pinia` store 持久化 token，E2E 需复用登录 helper。

## 6. 自动化目标

- 100% case 自动化（`automation.required = true`）。
- 通过 `aws run --change 20260612-user-mgmt` 可一键执行 API + E2E。
- E2E 在 headed 模式运行（符合项目约定 `uv run pytest tests/e2e/ -v --headed`）。

## 7. 通过准则（Done Definition）

- 全部 case 在执行阶段 PASS（或 PASS_WITH_WARNINGS 且警告均为已知非阻塞）。
- 所有 review gate（case / api-plan / e2e-plan）`decision = pass`。
- 测试代码落在 `tests/api/test_users_api.py` 与 `tests/e2e/test_users_e2e.py`。
- `qa/changes/20260612-user-mgmt/execution/{api,e2e}-result.json` 由 `aws run` 写入（非伪造）。

## 8. 后续阶段

按 aws-workflow 顺序：
1. ✅ Phase 1 Case Design（本文档）
2. → Phase 2 Case Review
3. → Phase 3.5 Fact Baseline
4. → Phase 4A/B Plans → 5A/B Reviews → 6A/B Fixes
5. → Phase 7A/B Codegen（INLINE）
6. → Phase 8 aws run
7. → Phase 9 Inspect（条件）→ 10–13 Healing（条件）
8. → Final Report（auto_archive=false，归档需用户确认）
