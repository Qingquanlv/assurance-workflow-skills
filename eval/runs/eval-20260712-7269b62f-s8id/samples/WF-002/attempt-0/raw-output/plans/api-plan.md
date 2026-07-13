# API Test Plan — roles module

**Change**: `eval-sample-002`
**Module**: `roles`
**Stage**: AWS M3 Stage 1 (planning, no code generation)
**Generated at**: 2026-06-15

---

## Source

- `qa/changes/eval-sample-002/cases/roles/case.yaml` (12 API cases under `added`)
- `qa/changes/eval-sample-002/proposal.md`
- `qa/changes/eval-sample-002/facts/fact-baseline.json`
- `.aws/data-knowledge.yaml`
- Backend: `app/api/v1/roles/roles.py`, `app/controllers/role.py`, `app/schemas/roles.py`

---

## API Targets (12 cases)

| Case ID | Method | Path | Expected |
|---|---|---|---|
| TC-ROLES-API-001 | GET | `/api/v1/role/list` | 200, paginated list with seed roles |
| TC-ROLES-API-002 | GET | `/api/v1/role/list?role_name=管理员` | 200, filtered results |
| TC-ROLES-API-003 | GET | `/api/v1/role/list` (no token) | 401 or 422 |
| TC-ROLES-API-004 | GET | `/api/v1/role/get?role_id={id}` | 200, role detail |
| TC-ROLES-API-005 | GET | `/api/v1/role/get?role_id=999999` | 404 |
| TC-ROLES-API-006 | POST | `/api/v1/role/create` | 200, created |
| TC-ROLES-API-007 | POST | `/api/v1/role/create` (duplicate name) | 400 |
| TC-ROLES-API-008 | POST | `/api/v1/role/update` | 200, updated |
| TC-ROLES-API-009 | POST | `/api/v1/role/update` (missing id) | 404 |
| TC-ROLES-API-010 | DELETE | `/api/v1/role/delete?role_id={id}` | 200, deleted |
| TC-ROLES-API-011 | DELETE | `/api/v1/role/delete?role_id=999999` | 404 |
| TC-ROLES-API-012 | GET/POST | `/api/v1/role/authorized` | 200, bind menus/apis |

---

## Auth Strategy

- Header name: `token` (NOT `Authorization: Bearer`)
- Admin login via `POST /api/v1/base/access_token` with seed admin credentials
- Anonymous cases use client without token header
- Fixtures from `.aws/data-knowledge.yaml`: `admin_token`, `seeded_two_roles`, `list_roles`, role API helpers

---

## Verification Strategy

- Prefer API roundtrip over direct ORM where async Tortoise bootstrap is unavailable
- Duplicate name message: `"The role with this rolename already exists in the system."`
- Authorized POST uses clear+add semantics for menu_ids and api_infos
