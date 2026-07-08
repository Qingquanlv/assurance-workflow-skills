# API Codegen Plan — roles module

**Change**: `eval-sample-002`
**Module**: `roles`
**Generated at**: 2026-06-15

---

## Output Layout

```
tests/api/
├── conftest.py              # bootstrap if missing (session admin_token)
├── helpers/
│   ├── auth.py              # login helper
│   └── role_api.py          # list/create/update/delete/authorized helpers
└── test_role_api.py         # NEW — 12 API test functions
```

---

## File Specifications

### NEW — `tests/api/test_role_api.py`

- One test function per TC-ROLES-API-001..012
- Markers: `@pytest.mark.api`
- Use httpx client from conftest; header `token: {jwt}`
- Constants: `NONEXISTENT_ROLE_ID = 999999`

### Helpers — `tests/api/helpers/role_api.py`

Wrap endpoints from data-knowledge `endpoints.role.*` and fixture helpers.

---

## Collect Command

`uv run pytest tests/api/test_role_api.py --collect-only -q`

Expected collected count: 12
