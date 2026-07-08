# Performance Plan — roles module

**Change:** `eval-sample-002`

## Scope

TC-ROLES-PERF-001 — light load on `GET /api/v1/role/list`.

## Thresholds (enforced by runner, not locustfile)

| Metric | Limit |
|--------|-------|
| p95_ms | 500 |
| error_rate_max | 0.01 |

## Scenario capability

- `role-list-query` — maps to Locust `name=` label
