# E2E Test Data Plan — Role Management (`20260615-role-mgmt`)

## Required Data per Case

| Case | Data Element | Source |
|---|---|---|
| TC-ROLE-100 | default admin role (pre-seeded) | `init_app` |
| TC-ROLE-100 | default admin user (pre-seeded) | `init_app` |
| TC-ROLE-101 | unique role name `e2e-role-new-{token}` | generated at test time |
| TC-ROLE-102 | pre-seeded role `e2e-role-auth-{token}` with empty bindings | `create_role_via_api` |
| TC-ROLE-102 | menu `部门管理` (id=6) — stable per fact baseline | `init_app` |

## Capability Mapping

| Capability | Source | Status |
|---|---|---|
| Frontend reachable at `http://localhost:3100` | env or default | runtime check |
| Backend reachable at `http://localhost:9999` | env or default | runtime check |
| Admin token | `get_admin_token()` | ✅ existing |
| Logged in page | `logged_in_page` fixture | ✅ existing |
| Role management page navigation | `role_management_page` fixture | ⚠️ NEW (this plan) |
| Unique role token | `unique_role_token` fixture | ⚠️ NEW (this plan) |
| Cleanup roles | `cleanup_roles` fixture | ⚠️ NEW (this plan) |
| Create role via API | `create_role_via_api` helper | ⚠️ NEW (this plan) |
| Delete role via API | `delete_role` helper | ⚠️ NEW (this plan) |
| Find role by name via API | `find_role_by_name` helper | ✅ existing |
| Get role authorized via API | `get_role_authorized` helper | ⚠️ NEW (this plan) |
| Menu `部门管理` (id=6) stable | `init_app` insertion order | ✅ confirmed in fact baseline |

## Setup Strategy

### TC-ROLE-100
1. `logged_in_page` fixture handles login.
2. Navigate to `/system/role` (via `role_management_page` fixture).
3. No data seeding needed.

### TC-ROLE-101
1. `logged_in_page` + navigate.
2. `unique_role_token` generates `{token}`; role name = `e2e-role-new-{token}`.
3. Pre-clean: lookup-and-delete leftover role (if any) via API.
4. Run UI flow: open modal → fill name + desc → save.
5. Assert success toast + search visibility.
6. Cleanup: append created role_id to `cleanup_roles`.

### TC-ROLE-102
1. `logged_in_page` (no nav yet).
2. `unique_role_token` generates `{token}`; role name = `e2e-role-auth-{token}`.
3. **API pre-seed**: `role_id = create_role_via_api(token=admin_token, name=role_name, desc="e2e auth test")` — this seeds a role with NO menu/api bindings (the controller call only creates the row; menus/apis are bound separately via `/role/authorized`).
4. Append `role_id` to `cleanup_roles` immediately (so failure mid-test still cleans up).
5. Navigate to `/system/role`.
6. Search → click 设置权限 → check `部门管理` in menu tab → save.
7. Assert success toast.
8. Close dialog.
9. Reopen dialog → assert checkbox state still checked.
10. API readback: `data = get_role_authorized(role_id, admin_token)` → `assert any(m["id"] == 6 for m in data["menus"])`.

## Runtime Verify

- TC-ROLE-101: after UI save success toast, additionally search by name in the table to confirm visibility (already in case assertions).
- TC-ROLE-102: after first save, fetch via API to confirm DB state (decoupled from UI re-open assertion which can be flaky on tree state).

## Cleanup Strategy

`cleanup_roles` fixture (yield-then-teardown pattern, mirrors `cleanup_users` / `cleanup_menus`):

```python
@pytest.fixture
def cleanup_roles(admin_token: str) -> Generator[list[int], None, None]:
    created: list[int] = []
    yield created
    for role_id in created:
        delete_role(role_id, admin_token)
```

Tests append role_ids during execution. Teardown idempotently deletes (404 = OK).

## Frontend / Backend Liveness

The aws-run skill is responsible for confirming both are live before E2E starts. Codegen MUST NOT attempt to start servers from within tests. Tests fail fast with a clear error if either is unreachable (httpx `ConnectError` from API setup, or Playwright navigation timeout).

## Blockers / Assumptions

**Blockers**: None.

**Assumptions**:

1. `localhost:3100` (frontend) and `localhost:9999` (backend) are reachable during test run.
2. Default admin (`admin` / `123456`) credentials valid.
3. Menu `部门管理` is at id=6 (deterministic per init_app — confirmed by fact baseline).
4. NaiveUI tree node click-checkbox pattern is stable; if it changes, NR-E2E-02 fallback applies.
5. Role page route is `/system/role` (verified by frontend convention `web/src/views/system/{module}` and consistent with menu/user pages).

## Review Checklist

- [ ] Confirm `/system/role` is the correct route (vs. `/system/role-mgmt` or similar).
- [ ] Confirm authorize dialog save button text ("保存" vs "确定").
- [ ] Confirm tree node checkbox click pattern in current NaiveUI version.
- [ ] Confirm pre-seeded admin role has at least one row in the table at TC-ROLE-100 (it should — admin is seeded).
- [ ] Confirm `部门管理` menu name is stable (it is — `init_app.py` line 89 uses literal name).
