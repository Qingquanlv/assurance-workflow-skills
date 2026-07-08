# API Codegen Plan — menus module

**Change**: `eval-sample-003`

---

## Output Layout

```
tests/api/
├── conftest.py
├── helpers/
│   ├── auth.py
│   └── menu_api.py
└── test_menu_api.py
```

- One test per TC-MENUS-API-001..009
- Collect: `uv run pytest tests/api/test_menu_api.py --collect-only -q`
- Expected count: 9
