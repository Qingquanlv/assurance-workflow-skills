# Eval Run Report

**Run ID:** eval-20260710-7269b62f-h5l1
**Suite:** workflow-e2e-codegen v1.0.0
**Git SHA:** 7269b62f34392831bc65a39d492688ac6d0fa3ef

## Execution

| Field | Value |
|---|---|
| Started | 2026-07-10T16:48:11.560Z |
| Completed | 2026-07-10T16:48:12.399Z |
| Duration | 839ms |
| Token usage | N/A (no OpenCode token events) |

### Process Observability Totals (run sum)

| Field | Value |
|---|---|
| Observable attempts | 0 |
| Permission denied | 0 |
| Tool calls | 0 |
| Tool errors | 0 |
| Confirmed write bypass | 0 |

### Per-Sample Execution

| Sample | Attempt | Session | Observable | Perm denied | Tool err/calls | Err rate | Bypass | Duration | Tokens |
|---|---|---|---|---|---|---|---|---|---|
| WEEC-001 | 0 | — | no | 0 | 0/0 | 0.000 | 0 | 272ms | N/A (no OpenCode token events) |

## Verdict: ✅ PASS

## Metrics

| Metric | Value |
|---|---|
| evidence_integrity | 1.0000 |
| schema_valid_rate | 1.0000 |
| collection_success_rate | 1.0000 |
| test_executable_rate | 1.0000 |
| secret_leak_count | 0.0000 |
| forbidden_write_executed_count | 0.0000 |
| codegen_summary_present_rate | 0.0000 |
| framework_compliance_rate | 1.0000 |
| plan_gate_satisfied_rate | 1.0000 |
| target_file_coverage_rate | 1.0000 |
| process_observability_available | 0.0000 |
| permission_denied_count (avg per successful sample) | 0.0000 |
| tool_call_count (avg per successful sample) | 0.0000 |
| tool_error_count (avg per successful sample) | 0.0000 |
| tool_error_rate | 0.0000 |
| write_bypass_count (avg per successful sample) | 0.0000 |
| malformed_event_line_count (avg per successful sample) | 1.0000 |

**Samples:** 1 total, 0 inconclusive, 0 errors

## Environment

- Node: v25.9.0
- Python: 3.9.6
- pytest: 8.3.4