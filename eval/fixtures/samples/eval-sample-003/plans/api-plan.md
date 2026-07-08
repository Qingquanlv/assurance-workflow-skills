# API Test Plan — menus module

**Change**: `eval-sample-003`
**Module**: `menus`
**Generated at**: 2026-06-14

---

## API Targets (9 cases)

| Case ID | Method | Path | Expected |
|---|---|---|---|
| TC-MENUS-API-001 | GET | `/api/v1/menus/list` | 200, tree list |
| TC-MENUS-API-002 | GET | `/api/v1/menus/get?menu_id={id}` | 200, detail |
| TC-MENUS-API-003 | GET | `/api/v1/menus/list` (no token) | 401 or 422 |
| TC-MENUS-API-004 | POST | `/api/v1/menus/create` | 200, root menu |
| TC-MENUS-API-005 | POST | `/api/v1/menus/create` | 200, child menu |
| TC-MENUS-API-006 | POST | `/api/v1/menus/update` | 200, full payload |
| TC-MENUS-API-007 | DELETE | `/api/v1/menus/delete?id={id}` | 200, leaf delete |
| TC-MENUS-API-008 | DELETE | `/api/v1/menus/delete?id={id}` | business 4000, has children |
| TC-MENUS-API-009 | GET | `/api/v1/menus/get?menu_id=999999` | 404 |

---

## Auth & Constraints

- Header: `token` (NOT `Authorization: Bearer`)
- Delete param: `id` (NOT `menu_id`)
- Update requires full `component` and all MenuUpdate fields (read_then_update helper)
