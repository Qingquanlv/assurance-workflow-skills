# Known Product Issues — eval-sample-004 (depts)

## ANOMALY-003 — Duplicate dept name returns HTTP 500

| Field | Value |
|-------|--------|
| **Case** | TC-DEPT-API-008 |
| **Endpoint** | `POST /api/v1/dept/create` |
| **Symptom** | Second create with an existing `name` returns HTTP 500 (IntegrityError) instead of 4xx or business `code != 200`. |
| **Root cause** | `Dept.name` has `unique=True` at ORM level; API layer does not catch duplicate-key errors. |
| **Test data** | Uses `unique_dept_name()` (≤20 chars) — failures on this case after data fix indicate product behavior, not name length. |
| **Classification** | `known_product_issue` (separate from `test_data_failure` / name overflow) |

### Evidence

- `app/models/admin.py` — `Dept.name` CharField max_length=20, unique=True
- `app/controllers/dept.py:57-62` — `create_dept` without duplicate handling
- WF-004 run `eval-20260622-c0bc6874-865o` — 9/14 pass; TC-008 failed with `assert 500 < 500` on duplicate create

### Expected fix (product)

Translate duplicate `Dept.name` into a controlled client error (e.g. HTTP 400/409 or business code 4000) instead of leaking 500.
