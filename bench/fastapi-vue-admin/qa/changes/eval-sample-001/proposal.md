# Proposal: eval-sample-001

## Why

This QA change re-establishes API-level regression coverage for the user management module (`app/api/v1/users/`) of vue-fastapi-admin. The module exposes 6 endpoints (list / get / create / update / delete / reset_password) that constitute the core RBAC user data lifecycle. A prior change (`20260612-user-mgmt`) authored 21 cases (15 API + 6 E2E) into `qa/cases/users/case.yaml`; this change tightens the 15 API cases against the latest schema contract and current source-of-truth facts (controller behavior, Pydantic schema, reset password fixed value), so downstream api-plan / api-codegen can generate valid pytest code without stale-field rework.

E2E coverage is intentionally out of scope for this run (`test_types: api`).

## Test Basis

- Requirement ID: REQ-USER-MGMT-API-REFRESH
- Feature Name: users-api-regression
- Source: module source code `app/api/v1/users/users.py`, `app/controllers/user.py`, `app/schemas/users.py`; existing cases `qa/cases/users/case.yaml`
- Target Module: users
- Target Case File: `qa/cases/users/case.yaml`

## What to Test

API behavior of the 6 user-management endpoints, covering:

| Endpoint | Method | Coverage |
|---|---|---|
| `/api/v1/user/list` | GET | default pagination, username fuzzy search, unauthenticated 401 |
| `/api/v1/user/get` | GET | normal fetch, missing id, unauthenticated |
| `/api/v1/user/create` | POST | normal create (with role_ids), email duplicate 400, missing required field 422 |
| `/api/v1/user/update` | POST | normal update (role rewrite), missing id |
| `/api/v1/user/delete` | DELETE | normal delete, missing id |
| `/api/v1/user/reset_password` | POST | normal user reset success, superuser 403, missing id |

## Out of Scope

- E2E cases (`/system/user` page interactions) — `test_types: api` for this run.
- `/api/v1/base/update_password` (self password change, belongs to base module).
- Department / role / menu / api CRUD (independent changes).
- Avatar upload, frontend visual regression.
- DB migration / init scripts.

## Confirmed Coverage Approach

**B. API only (refresh + tighten)** — selected because the invocation explicitly sets `test_types: api`. Existing API cases are kept (modified, not re-added) so case IDs stay stable; their schema is aligned to the latest `aws-case-design` contract and their assertions / data needs are tightened against current source-of-truth behavior (e.g. reset password fixed value `123456`, 403 on superuser, `clear()+add()` role rewrite, `EmailStr` 422 validation).

## Test Conditions

| Condition ID | Condition | Source | Priority | Risk Level | Design Technique |
|---|---|---|---|---|---|
| COND-USER-LIST-001 | 管理员默认分页获取用户列表且不返回密码 | REQ-USER-LIST-DEFAULT | P0 | high | use_case |
| COND-USER-LIST-002 | 用户名模糊搜索仅返回匹配项 | REQ-USER-LIST-SEARCH | P1 | medium | equivalence_partitioning |
| COND-USER-LIST-003 | 未携带凭证访问列表被拒绝 | REQ-USER-AUTH-LIST | P0 | high | negative |
| COND-USER-GET-001 | 按 ID 查询用户详情且隐藏密码 | REQ-USER-GET-OK | P0 | high | use_case |
| COND-USER-GET-002 | 不存在 ID 返回错误 | REQ-USER-GET-MISSING | P1 | medium | negative |
| COND-USER-CREATE-001 | 创建用户并绑定角色且密码加密 | REQ-USER-CREATE-OK | P0 | high | use_case |
| COND-USER-CREATE-002 | 邮箱重复返回业务错误 | REQ-USER-CREATE-DUP-EMAIL | P1 | medium | negative |
| COND-USER-CREATE-003 | 缺少必填字段返回参数校验错误 | REQ-USER-CREATE-VALIDATION | P2 | medium | boundary_value_analysis |
| COND-USER-UPDATE-001 | 更新用户名并完全重写角色集合 | REQ-USER-UPDATE-OK | P0 | high | use_case |
| COND-USER-UPDATE-002 | 不存在 ID 更新返回错误 | REQ-USER-UPDATE-MISSING | P1 | medium | negative |
| COND-USER-DELETE-001 | 按 ID 删除用户成功 | REQ-USER-DELETE-OK | P0 | high | use_case |
| COND-USER-DELETE-002 | 不存在 ID 删除返回错误 | REQ-USER-DELETE-MISSING | P2 | medium | negative |
| COND-USER-RESET-001 | 重置普通用户密码成功且新密码可用 | REQ-USER-RESET-OK | P0 | high | use_case |
| COND-USER-RESET-002 | 拒绝重置超级管理员密码 | REQ-USER-RESET-PROTECT-SUPER | P0 | high | negative |
| COND-USER-RESET-003 | 不存在 ID 重置密码返回错误 | REQ-USER-RESET-MISSING | P2 | low | negative |

## Priority / Risk Mapping Note

Per `aws-case-design` rule 45, P0/P1 cases should map to high/critical risk. Four P1 cases in this delta intentionally carry `medium` risk because they cover error paths or non-critical-filter scenarios whose business impact is bounded:

| Case | Priority | Risk Level | Rationale |
|---|---|---|---|
| TC-USER-002 | P1 | medium | Username search filter — failure has a full-list fallback path |
| TC-USER-011 | P1 | medium | Get missing ID — error-code consistency only |
| TC-USER-021 | P1 | medium | Email duplicate on create — data integrity, but caught at creation boundary |
| TC-USER-031 | P1 | medium | Update missing ID — silent-success prevention, not data loss |

These are kept at P1 (regression tier) for coverage value, but their risk is genuinely medium. This is an intentional design decision, not an oversight.

## Quality Risks

| Risk | Likelihood | Impact | Level | Mitigation |
|---|---|---|---|---|
| 超级管理员密码重置保护被绕过 | 1 | 5 | high | TC-USER-051 显式覆盖 403 分支 |
| 角色 m2m 重写语义被误解为增量 | 3 | 5 | high | TC-USER-030 断言最终角色集合仅含新入参 |
| 邮箱唯一性仅在 create 校验，update 不校验 | 3 | 3 | medium | proposal 显式 Out of Scope 此差异 |
| 重置后固定密码 `123456` 与弱密码策略冲突 | 2 | 4 | medium | TC-USER-050 断言重置后可用此值登录；不测试策略 |
| 未携带凭证被错误放行 | 2 | 5 | high | TC-USER-003 覆盖 401 分支 |

## Test Types

- API

## Layer Rationale

For each case in this change, the layer assignment and rationale:

- TC-USER-001: API
  - reason: 验证 HTTP 200 响应体结构与分页字段，单请求断言即可，无需浏览器交互。
- TC-USER-002: API
  - reason: 验证 `username__contains` 查询过滤行为，直接断言返回记录数与字段值。
- TC-USER-003: API
  - reason: 验证未携带凭证时 401 拒绝访问，属于鉴权边界单请求断言。
- TC-USER-010: API
  - reason: 验证按 ID 查询详情且排除 password 字段，单请求断言。
- TC-USER-011: API
  - reason: 验证不存在 ID 的错误返回，单请求错误码断言。
- TC-USER-020: API
  - reason: 验证创建用户成功、角色绑定、密码哈希加密，通过响应 + ORM 校验最终状态。
- TC-USER-021: API
  - reason: 验证邮箱重复返回 400 业务错误，单请求错误码断言 + 数据库无新增校验。
- TC-USER-022: API
  - reason: 验证 Pydantic `EmailStr` 缺失触发 422 参数校验错误，单请求错误码断言。
- TC-USER-030: API
  - reason: 验证 `update_roles` 的 `clear()+add()` 重写语义，通过 ORM 校验最终角色集合。
- TC-USER-031: API
  - reason: 验证更新不存在 ID 的错误返回，单请求错误码断言。
- TC-USER-040: API
  - reason: 验证删除用户后数据库无此记录，响应 + ORM 校验。
- TC-USER-041: API
  - reason: 验证删除不存在 ID 的错误返回，单请求错误码断言。
- TC-USER-050: API
  - reason: 验证重置密码后固定密码 `123456` 可登录，通过响应 + 登录尝试双请求断言。
- TC-USER-051: API
  - reason: 验证 `is_superuser=True` 用户重置密码返回 403 且原密码仍可用，单请求错误码 + 登录断言。
- TC-USER-052: API
  - reason: 验证重置不存在 ID 的错误返回，单请求错误码断言。

## Data Needs

- 可复用的管理员登录 fixture（`admin` / `123456`）获取 Bearer token。
- 至少一个可绑定的普通角色 ID（fact baseline 阶段确定）。
- 两个互不相同的角色 ID（用于 TC-USER-030 角色重写断言）。
- 唯一用户名 / 唯一邮箱生成器（避免与既有数据冲突），每个 case 在 tearDown 中清理自建数据。
- 超级管理员账号保持不变（不创建、不删除）。

## Success Assertions

- 列表 / 详情接口返回的 user dict 中不包含 `password` 字段。
- 创建 / 更新接口成功后，ORM 查询到的用户密码为哈希值，不等于明文入参。
- 更新用户的角色集合等于入参 `role_ids`（完全重写，不保留旧角色）。
- 重置密码后用固定密码 `123456` 可登录目标用户。
- 超级管理员重置密码返回 HTTP 403，原密码仍可登录。
- 未携带凭证访问受保护端点返回 401。
- 缺少 `email` 字段创建用户返回 422。
- 邮箱重复创建返回 400 业务错误且数据库无新增。

## Exception Scenarios

已纳入的异常分支（standard 深度，每 endpoint 1–2 个）：
- 鉴权失败 401（list 覆盖一次）
- 业务冲突 400（create email 重复）
- 资源不存在（get / update / delete / reset_password 不存在 ID）
- 字段校验 422（create 缺 email）
- 权限保护 403（reset_password 拒绝超级管理员）

显式排除：update 路径的 email 重复差异（Out of Scope）。

## Entry Criteria

- Requirements are clear enough to derive test conditions.
- Target module `users` is confirmed.
- Target case file path `qa/cases/users/case.yaml` confirmed.
- Required fixtures (admin token, role IDs, unique user generator) can be created or reused.

## Exit Criteria for This Phase

- `proposal.md` is written.
- `cases/users/case.yaml` is generated and self-reviewed.
- Each case is traceable to `requirement_id` and `test_condition_id`.
- Test targets (`type: API`) are identified and confirmed (`automation.confirmed_by: user`).
- Ready for `aws-case-reviewer`.

## Downstream Exit Criteria

- After case review passes, `plans/api-plan.md` + `plans/api-test-data-plan.md` + `plans/api-codegen-plan.md` can be generated by `aws-api-plan`.
- After codegen and execution, traceability can be updated by downstream execution/archive phases (`aws-run`, `aws-archive`).
