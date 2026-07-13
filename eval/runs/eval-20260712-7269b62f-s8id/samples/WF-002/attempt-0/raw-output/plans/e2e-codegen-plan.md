# E2E Codegen Plan — roles module

**Change:** `eval-sample-002`

## Target Files

- `tests/e2e/eval/test_role_eval_smoke.py` — smoke test for TC-ROLES-E2E-001

## Generated File Policy

- Python Playwright only — **no** `.spec.ts` files under `tests/e2e/`
- Markers: `@pytest.mark.e2e`
- Eval smoke lives under `tests/e2e/eval/` with `--confcutdir=tests/e2e/eval` (no bench conftest)

## Collect Command

`pytest tests/e2e/eval --collect-only -q --confcutdir=tests/e2e/eval`
