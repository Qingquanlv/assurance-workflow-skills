# Fuzz Plan — users module

**Change:** `eval-sample-001`

## Scope

TC-USER-FUZZ-001 — schema-based fuzz on `GET /api/v1/user/list`.

## Schema acquisition

- `OPENAPI_URL` env (default `http://localhost:9999/openapi.json`)
- Use `schemathesis.from_uri(OPENAPI_URL)` with auth header strategy from plan

## Expectations

- No 5xx responses for schema-conformant inputs
- Response bodies conform to declared schema
