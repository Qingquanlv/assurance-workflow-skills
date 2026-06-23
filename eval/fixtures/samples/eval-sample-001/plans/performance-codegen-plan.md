# Performance Codegen Plan — users module

**Change:** `eval-sample-001`

## Target Files

- `tests/perf/locustfile_users.py`

## Load behavior

- 1 HttpUser class with `@task` hitting `/api/v1/user/list`
- `name="user-list-query"` for threshold mapping

## Collect Command

`locust -f tests/perf/locustfile_users.py --list`
