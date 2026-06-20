# M4 Stage 1 — E2E Plan Self-Review Summary

**Change ID**: `20260612-user-mgmt`
**Module**: `users`
**Phase**: 4B — E2E Planning (aws-e2e-plan)
**Generated**: 2026-06-12
**Skill**: `aws-e2e-plan` (inline)

---

## 1. Artifacts produced (Phase 4B)

| File | Path | Status |
|---|---|---|
| E2E plan | `qa/changes/20260612-user-mgmt/plans/e2e-plan.md` | ✅ written |
| E2E test data plan | `qa/changes/20260612-user-mgmt/plans/e2e-test-data-plan.md` | ✅ written |
| E2E codegen plan | `qa/changes/20260612-user-mgmt/plans/e2e-codegen-plan.md` | ✅ written |
| M4 review summary | `qa/changes/20260612-user-mgmt/plans/m4-review-summary.md` | ✅ this file |

---

## 2. Scope coverage

### 2.1 Cases planned (E2E only, automation.required=true)

| Case ID | Title | Priority | Plan section |
|---|---|---|---|
| TC-USER-100 | 管理员登录后进入用户管理页 | P0 | e2e-plan.md §5.1 |
| TC-USER-101 | 通过页面新增用户成功并出现在列表 | P0 | e2e-plan.md §5.2 |
| TC-USER-102 | 编辑用户名称后刷新列表保持新值 | P1 | e2e-plan.md §5.3 |
| TC-USER-103 | 给用户分配角色后下次进入编辑勾选保留 | P1 | e2e-plan.md §5.4 |
| TC-USER-104 | 通过列表删除按钮删除用户 | P0 | e2e-plan.md §5.5 |
| TC-USER-105 | 用户列表用户名搜索过滤 | P2 | e2e-plan.md §5.6 (NR-E2E-PLAN-001) |

**Total**: 6 cases, all mapped to test functions in `e2e-codegen-plan.md` §5.

### 2.2 Cases skipped

None. P2 case (TC-USER-105) explicitly included with reviewer ack flag (NR-E2E-PLAN-001).

---

## 3. Self-decision

**Decision**: `pass`
**Codegen readiness**: `ready`
**Blockers**: 0
**Advisory needs-review**: 5

### 3.1 Needs-review items (all non-blocking)

| ID | Topic | Resolution path |
|---|---|---|
| NR-E2E-PLAN-001 | TC-USER-105 P2 inclusion ack | Reviewer flag — not a code change |
| NR-E2E-PLAN-002 | CrudModal save button text "确定" | Codegen-time verify in `web/src/components/table/CrudModal.vue` |
| NR-E2E-PLAN-003 | Modal title format ("新增 用户" / "编辑 用户") | Codegen-time verify in `web/src/composables/useCRUD.{js,ts}` |
| NR-E2E-PLAN-004 | Add helper `create_user_via_api` to `tests/e2e/scripts/user_data_setup.py` | Already documented in codegen plan §3 |
| NR-E2E-PLAN-005 | Toast tolerance for "成功" message variations | `.n-message` filter `has_text="成功"` chosen as resilient default |

---

## 4. Quality gates checklist

| Gate | Pass? | Evidence |
|---|---|---|
| All E2E cases from case.yaml planned | ✅ | 6/6 mapped (§2.1) |
| Selectors grounded in source UI (or deferred via NR) | ✅ | `web/src/views/system/user/index.vue` read; G1-G3 deferred to codegen |
| Auth strategy explicit | ✅ | `logged_in_page` fixture per data-knowledge.yaml |
| Data lifecycle explicit | ✅ | e2e-test-data-plan.md §3-5 |
| Cleanup explicit + idempotent | ✅ | session-scoped `cleanup_users` + defensive register |
| Naming conventions explicit | ✅ | `qa_e2e_<intent>_<hex8>` (e2e-test-data-plan.md §4) |
| Wait strategy explicit (no `time.sleep`) | ✅ | `expect_response` + `expect().to_be_visible(timeout=...)` only |
| Failure modes catalogued | ✅ | e2e-plan.md §9 (selector drift, network, role missing, timing) |
| Cross-module deps stated | ✅ | seeded role `普通用户` documented |
| Codegen file layout explicit | ✅ | e2e-codegen-plan.md §1 |
| Test function inventory explicit | ✅ | e2e-codegen-plan.md §5 |
| Imports listed | ✅ | e2e-codegen-plan.md §8 |
| Out-of-scope listed | ✅ | e2e-codegen-plan.md §10 |
| Greenfield-aware (no fabricated reference tests) | ✅ | e2e-codegen-plan.md §9 |
| HTTP details NOT leaked into case.yaml | ✅ | All endpoint paths only in plans/, not cases/ |
| `data-knowledge.yaml` fixtures honoured | ✅ | logged_in_page, e2e_api_client, cleanup_users, etc. all referenced by exact name |

---

## 5. Risk register

| Risk | Mitigation |
|---|---|
| Naive UI selector drift across versions | Role/text-based selectors with visible-text fallback; codegen-time UI gate (G1-G3) |
| `普通用户` role rename in seed | TC-USER-103 skips with clear message via `find_role_by_name` |
| Toast message text variation | `.n-message` filter on `has_text="成功"` is permissive |
| Modal stacking when previous modal didn't close | Always use `.n-modal.last` as scope |
| Concurrent test runs hitting shared sqlite | Project uses sqlite + serialized tests (no xdist); already noted in API plan |
| Frontend not running on `:3100` | Conftest reads `E2E_FRONTEND_URL` env override |
| Backend not running on `:9999` | Same env override pattern |

---

## 6. Cross-module dependencies

| Dep | Source | Used by |
|---|---|---|
| Seeded role `普通用户` | `app/core/init_app.py` | TC-USER-103 |
| Seeded role (any) | `app/core/init_app.py` | TC-USER-101 (any role) |
| Admin user `admin/123456` | `app/core/init_app.py` | All tests via `logged_in_page` |
| `/api/v1/role/list` endpoint | `app/api/v1/roles/roles.py` | role_data_setup.py helper |
| `/api/v1/user/*` endpoints | `app/api/v1/users/users.py` | All tests + helpers |

---

## 7. Phase 5B reviewer prompt hints

For `aws-e2e-plan-reviewer`:

- Plan is greenfield-aware: no existing E2E tests to mirror
- 5 NR items are documented in plan files; reviewer should confirm none have escalated to blockers
- Selector deferral (G1-G3) is **intentional codegen-time verification**, not planning-time uncertainty
- API plan (`api-plan.md`) defines canonical helper idiom; E2E reuses where overlapping
- Phase 6B fixer would only re-write planning files; selector strategy itself is sound

---

## 8. Decision rationale

The plan is `pass / ready` because:

1. All 6 E2E cases have a concrete test function with stepwise pseudocode
2. Every selector has a primary strategy + a documented fallback
3. Every test has a deterministic data lifecycle (create-via-API, exercise-via-UI, cleanup-via-API)
4. No planning-time blockers exist; all 5 NR items are reviewer flags or codegen-time gates
5. Out-of-scope is stated; risks have mitigations
6. The plan respects the aws-workflow inline rule (no subagent delegation, no codegen leakage)

**Phase 4B → COMPLETE. Ready for Phase 5B aws-e2e-plan-reviewer.**
