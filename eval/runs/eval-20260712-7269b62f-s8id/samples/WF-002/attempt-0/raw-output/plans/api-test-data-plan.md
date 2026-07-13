# API Test Data Plan — roles module

**Change**: `eval-sample-002`
**Module**: `roles`
**Generated at**: 2026-06-15

---

## Strategy

Per-case isolation via factory fixtures and helpers. Create temporary roles with unique names (`qa_role_*` prefix), delete in teardown. Seed roles「管理员」「普通用户」from `init_app.py` are read-only references.

---

## Per-Case Data

| Case | Setup | Cleanup |
|---|---|---|
| TC-ROLES-API-001/002 | Default seed roles | None |
| TC-ROLES-API-003 | No auth | None |
| TC-ROLES-API-004 | Lookup seed role id | None |
| TC-ROLES-API-005/009/011 | Use NONEXISTENT_ID=999999 | None |
| TC-ROLES-API-006/008/010 | Create temp role | Delete via API |
| TC-ROLES-API-007 | Create role then duplicate create | Delete temp |
| TC-ROLES-API-012 | Temp role + seed menu ids from list_menus | Delete temp role |

---

## Fixtures (from data-knowledge)

- `admin_token`, `api_client`, `unauthenticated_client`
- `seeded_two_roles` for authorized binding cases
- Helpers: `list_roles`, `create_role`, `delete_role`, `get_role_authorized`, `update_role_authorized`
