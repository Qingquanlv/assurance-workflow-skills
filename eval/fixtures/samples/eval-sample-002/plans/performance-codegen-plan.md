# Performance Codegen Plan — roles module

**Change:** `eval-sample-002`

## Target Files

- `qa/perf/locustfile_roles.py`

## Load behavior

- 1 HttpUser class with `@task` hitting `/api/v1/role/list`
- `name="role-list-query"` for threshold mapping

## Collect Command

`locust -f qa/perf/locustfile_roles.py --list`
