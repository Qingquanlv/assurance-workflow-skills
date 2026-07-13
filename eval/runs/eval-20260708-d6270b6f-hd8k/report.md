# Eval Run Report

**Run ID:** eval-20260708-d6270b6f-hd8k
**Suite:** workflow-api-codegen v1.0.0
**Git SHA:** d6270b6f8f79a586f3e42758f837b50b96350cba

## Execution

| Field | Value |
|---|---|
| Started | 2026-07-08T07:13:47.279Z |
| Completed | 2026-07-08T07:13:49.056Z |
| Duration | 1.8s |
| Token usage | N/A (no OpenCode token events) |

### Per-Sample Execution

| Sample | Attempt | Started | Completed | Duration | Tokens |
|---|---|---|---|---|---|
| WAC-001 | 0 | — | — | 280ms | N/A (no OpenCode token events) |

## Verdict: ❌ FAIL

## Metrics

| Metric | Value |
|---|---|
| evidence_integrity | 1.0000 |
| schema_valid_rate | 1.0000 |
| collection_success_rate | 0.0000 |
| test_executable_rate | 0.0000 |
| secret_leak_count | 0.0000 |
| forbidden_write_executed_count | 0.0000 |
| codegen_summary_present_rate | 0.0000 |
| plan_gate_satisfied_rate | 1.0000 |
| target_file_coverage_rate | 1.0000 |

**Samples:** 1 total, 0 inconclusive, 0 errors

## Hard Gate Failures

- ❌ collection_success_rate
- ❌ test_executable_rate

## Environment

- Node: v25.9.0
- Python: 3.9.6
- pytest: 8.4.2