# Performance Plan — users module

**Change:** `eval-sample-001`

## Scope

TC-USER-PERF-001 — light load on `GET /api/v1/user/list`.

## Thresholds (enforced by runner, not locustfile)

| Metric | Limit |
|--------|-------|
| p95_ms | 500 |
| error_rate_max | 0.01 |

## Scenario capability

- `user-list-query` — maps to Locust `name=` label
