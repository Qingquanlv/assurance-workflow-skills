# API Codegen Plan — depts module

**Change**: `eval-sample-004`
**Module**: `depts`

---

## Output Layout

```
tests/api/
├── conftest.py
├── helpers/
│   ├── auth.py
│   └── dept_api.py
└── test_dept_api.py
```

---

## Specifications

- One test per TC-DEPT-API-001..014
- Markers: `@pytest.mark.api`
- Collect: `uv run pytest tests/api/test_dept_api.py --collect-only -q`
- Expected collected count: 14
