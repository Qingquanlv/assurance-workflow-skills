# Eval Run Report

**Run ID:** eval-20260712-7269b62f-s8id
**Suite:** workflow-full v1.0.0
**Git SHA:** 7269b62f34392831bc65a39d492688ac6d0fa3ef

## Execution

| Field | Value |
|---|---|
| Started | 2026-07-12T18:00:45.152Z |
| Completed | 2026-07-12T18:00:46.854Z |
| Duration | 1.7s |
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
| WF-001 | 0 | — | no | 0 | 0/0 | 0.000 | 0 | 346ms | N/A (no OpenCode token events) |
| WF-002 | 0 | — | no | 0 | 0/0 | 0.000 | 0 | 330ms | N/A (no OpenCode token events) |
| WF-003 | 0 | — | no | 0 | 0/0 | 0.000 | 0 | 355ms | N/A (no OpenCode token events) |
| WF-004 | 0 | — | no | 0 | 0/0 | 0.000 | 0 | 345ms | N/A (no OpenCode token events) |

## Verdict: ✅ PASS

## Metrics

| Metric | Value |
|---|---|
| full_run_completed_rate | 1.0000 |
| end_to_end_pass_rate | 1.0000 |
| healing_triggered_rate | 0.2500 |
| wall_time_seconds | 0.3440 |
| evidence_integrity_diag | 1.0000 |
| process_observability_available | 0.0000 |
| permission_denied_count (avg per successful sample) | 0.0000 |
| tool_call_count (avg per successful sample) | 0.0000 |
| tool_error_count (avg per successful sample) | 0.0000 |
| tool_error_rate | 0.0000 |
| write_bypass_count (avg per successful sample) | 0.0000 |
| malformed_event_line_count (avg per successful sample) | 1.0000 |

**Samples:** 4 total, 0 inconclusive, 0 errors

## Environment

- Node: v25.9.0
- Python: 3.9.6
- pytest: 8.3.4