---
name: aws-fuzz-codegen
description: "AWS M3 Fuzz Stage 2: generate schemathesis fuzz tests from a reviewed fuzz plan. Use only after fuzz-plan-review.json has decision == pass and codegen_readiness in [ready, ready_with_warnings]. Reads fuzz plan files and writes tests/fuzz/test_<module>_fuzz.py. Does NOT execute pytest — execution is Phase 8 aws-run."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.fuzz_plan_review.status == pass`.
3. Read input files: `plans/fuzz-plan.md`, `plans/fuzz-codegen-plan.md`, `plans/fuzz-review-summary.md`, `review/fuzz-plan-review.json`, selected `cases/**/case.yaml` (type == Fuzz).
4. Verify `review/fuzz-plan-review.json` gate fields in order — **STOP** on first failure:
   - valid JSON
   - `review_type == "fuzz-plan"`
   - `change_id == <change-id>`
   - `decision == "pass"`
   - `codegen_readiness in ["ready", "ready_with_warnings"]`
   - `blockers` is empty
   - no `needs_review` item has `blocking == true`
5. Use files as the sole source of truth.

**After completing work:**

1. Write generated fuzz test files per `fuzz-codegen-plan.md` Target Files:
   - `tests/fuzz/test_<module>_fuzz.py` (required path — runner discovers `tests/fuzz/`)
   - `qa/changes/<change-id>/codegen/fuzz-codegen-summary.md`
2. Update `workflow-state.yaml`:
   - Set `phases.fuzz_codegen.status = done`
   - Set `phases.fuzz_codegen.review_gate_file = review/fuzz-plan-review.json`
   - List generated files under `phases.fuzz_codegen.generated_tests.files`

---

# AWS Fuzz Codegen

## Purpose

Translate a reviewed fuzz plan into executable schemathesis tests. This skill does **not** execute pytest — execution is Phase 8 `aws-run`.

## What to Generate

Fuzz tests use schemathesis's pytest integration so they run on the existing pytest infrastructure and emit JUnit XML:

```python
import schemathesis
from app.main import app  # per plan's schema acquisition strategy

schema = schemathesis.from_asgi("/openapi.json", app)

@schema.parametrize(endpoint="/api/v1/menu/create")
def test_menu_create_fuzz(case):
    response = case.call_asgi()
    case.validate_response(response)   # asserts: no 5xx, response conforms to declared schema
```

- Use `from_asgi` (in-process) when the plan specifies it; otherwise `from_uri` against the live base URL.
- Pass auth via the plan's strategy (reuse fixtures / data-knowledge). Never hardcode real tokens.
- Output exactly to `tests/fuzz/test_<module>_fuzz.py` so the CLI runner discovers it.

## Test Failure Integrity

Generated fuzz tests MUST fail for the right reason. Rules:

- Every assertion MUST map to a plan expectation (no 5xx / schema-valid input not wrongly rejected / response schema-conformant).
- Do not use `assert True`, placeholder assertions, or empty expectations.
- Do not swallow failures with empty `try/except` or `except Exception: pass`.
- Do not add fallback logic that hides product failures (a real 5xx surfaced by fuzzing is a product defect, not something to suppress).
- Do not use `skip`, `xfail`, early return, or hypothesis settings that disable generation to make fuzz tests green.
- Do not loosen `validate_response` or narrow the endpoint set after observing failures.
- Do not mock the behavior under test.
- Setup may be flexible; assertions must be strict.

Self-check before reporting complete:
1. Would this test fail if the endpoint returns a 5xx or violates its schema?
2. Does every assertion trace back to the plan's expectations?
3. Are setup failures reported instead of hidden?

If any answer is unsafe, fix the test before reporting codegen complete.

## Hard Rules

- STOP if the gate (`fuzz-plan-review.json`) is not `pass` with empty blockers.
- Do not run pytest or produce execution results — that is Phase 8 `aws-run`.
- Do not design new cases or change test scope.
- Do not write to `tests/api/` or `tests/e2e/` — fuzz output goes to `tests/fuzz/` only.
- Do not weaken assertions to force green; a fuzz-discovered product crash is a defect to report.
