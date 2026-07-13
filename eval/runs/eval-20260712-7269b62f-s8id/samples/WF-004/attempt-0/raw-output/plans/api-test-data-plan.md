# API Test Data Plan — depts module

**Change**: `eval-sample-004`
**Module**: `depts`

---

## Strategy

Per-case isolation: create temp departments with unique names (`qa_dept_*`), delete in teardown. Tree cases create parent then child, delete children before parents.

---

## Fixtures

- `admin_token`, `api_client`, `unauthenticated_client`
- Helpers from data-knowledge: dept list/get/create/update/delete wrappers
- Constants: `NONEXISTENT_DEPT_ID = 999999`
