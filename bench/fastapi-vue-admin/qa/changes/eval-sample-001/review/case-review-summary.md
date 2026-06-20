# Case Review Summary

## Decision

- Decision: pass
- Risk: low
- Auto Fix Allowed: false
- Human Review Required: false

## Summary

Case delta for `eval-sample-001` passes review. 15 API cases (all `modified` — case_ids already exist in `qa/cases/users/case.yaml`) covering 6 user-management endpoints with happy paths, error paths, auth boundary, validation, and permission protection.

Schema is aligned to the latest `aws-case-design` contract:
- No `automation.target` field (forbidden — `type` is the single source of truth)
- Valid `design_technique` enums (`negative` replaces non-enum `error_guessing`)
- Valid `selection_reason` enums (`critical_user_journey`, `security_related`, `contract_boundary`)
- Valid `maintenance_rule` enums (`keep_until_feature_deprecated`, `review_after_refactor`)
- `confirmed_by: user` and `confirmed_at` populated
- `suggested_file: tests/api/test_users_api.py` set on all cases

Source-of-truth facts tightened:
- TC-USER-050 references fixed password `123456` (`app/controllers/user.py:56`)
- TC-USER-051 asserts HTTP 403 (`app/controllers/user.py:54-55`)

E2E cases are out of scope per `test_types: api`.

## Blockers

None.

## Findings

### CASE-FINDING-001 (low, traceability)

Four P1 cases (TC-USER-002, TC-USER-011, TC-USER-021, TC-USER-031) have `medium` risk.level while priority is P1. `aws-case-design` rule 45 expects P0/P1 to map to high/critical risk.

Documented in `proposal.md` Priority/Risk Mapping Note as an intentional design decision — these are error-path / filter cases with bounded business impact. No change required.

### CASE-FINDING-002 (low, clarity)

TC-USER-022 uses `design_technique=boundary_value_analysis` but tests a missing-field (presence) scenario. Strictly this is `equivalence_partitioning` (present vs absent class). Acceptable as-is — boundary_value_analysis is a valid technique for schema boundary.

## Auto Fix Plan

None — no auto-fixable findings.

## Next Action

`continue` — case review passed, workflow advances to Phase 3.5 (Fact Baseline) and Phase 3.6 (Layer Scan) per `case-only` run mode.
