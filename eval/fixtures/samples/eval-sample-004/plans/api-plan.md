# API Test Plan — depts module

**Change**: `eval-sample-004`
**Module**: `depts`
**Generated at**: 2026-06-14

---

## Source

- `qa/changes/eval-sample-004/cases/depts/case.yaml` (14 API cases)
- `qa/changes/eval-sample-004/facts/fact-baseline.json`
- `.aws/data-knowledge.yaml`
- Backend: `app/api/v1/depts/depts.py`, `app/schemas/depts.py`

---

## API Targets (14 cases)

| Case ID | Method | Path | Expected |
|---|---|---|---|
| TC-DEPT-API-001 | GET | `/api/v1/dept/list` | 200, tree list |
| TC-DEPT-API-002 | GET | `/api/v1/dept/list?name=...` | 200, filtered |
| TC-DEPT-API-003 | GET | `/api/v1/dept/list` (no token) | 401 or 422 |
| TC-DEPT-API-004 | GET | `/api/v1/dept/get?id={id}` | 200, detail |
| TC-DEPT-API-005 | GET | `/api/v1/dept/get?id=999999` | 404 |
| TC-DEPT-API-006 | POST | `/api/v1/dept/create` | 200, root dept |
| TC-DEPT-API-007 | POST | `/api/v1/dept/create` | 200, child dept |
| TC-DEPT-API-008 | POST | `/api/v1/dept/update` | 200, updated |
| TC-DEPT-API-009 | POST | `/api/v1/dept/update` (missing id) | 404 |
| TC-DEPT-API-010 | DELETE | `/api/v1/dept/delete?dept_id={id}` | 200, deleted |
| TC-DEPT-API-011 | DELETE | `/api/v1/dept/delete?dept_id=999999` | 404 |
| TC-DEPT-API-012 | POST | `/api/v1/dept/create` (duplicate name) | 400 |
| TC-DEPT-API-013 | POST | `/api/v1/dept/update` (closure/parent change) | 200 |
| TC-DEPT-API-014 | GET | `/api/v1/dept/list` (tree shape) | nested children |

---

## Auth Strategy

- Header: `token` (NOT `Authorization: Bearer`)
- Admin login via `POST /api/v1/base/access_token`
- Delete param: `dept_id` (not `id`)
