---
name: aws-performance-codegen
description: "AWS M3 Performance Stage 2: generate Locust load tests from a reviewed performance plan. Use only after performance-plan-review.json has decision == pass and codegen_readiness in [ready, ready_with_warnings]. Reads performance plan files and writes tests/perf/locustfile_<module>.py. Does NOT execute Locust — execution is Phase 8 aws-run."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.performance_plan_review.status == pass`.
3. Read input files: `plans/performance-plan.md`, `plans/performance-codegen-plan.md`, `plans/performance-review-summary.md`, `review/performance-plan-review.json`, selected `cases/**/case.yaml` (type == Performance).
4. Verify `review/performance-plan-review.json` gate fields in order — **STOP** on first failure:
   - valid JSON
   - `review_type == "performance-plan"`
   - `change_id == <change-id>`
   - `decision == "pass"`
   - `codegen_readiness in ["ready", "ready_with_warnings"]`
   - `blockers` is empty
   - no `needs_review` item has `blocking == true`
5. Use files as the sole source of truth.

**After completing work:**

1. Write generated Locust files per `performance-codegen-plan.md` Target Files:
   - `tests/perf/locustfile_<module>.py` (required path — runner discovers `tests/perf/`)
   - `qa/changes/<change-id>/codegen/performance-codegen-summary.md`
2. Report the `workflow-state.yaml` state delta (inline mode: apply it directly; dispatched subagent: never write `workflow-state.yaml` — report the values in your final message and the orchestrator applies them):
   - `phases.performance_codegen.status = done`
   - `phases.performance_codegen.review_gate_file = review/performance-plan-review.json`
   - `phases.performance_codegen.generated_tests.files` = list of generated files

---

# AWS Performance Codegen

## Purpose

Translate a reviewed performance plan into an executable Locust load test. This skill does **not** execute Locust — execution is Phase 8 `aws-run`.

## What to Generate

```python
from locust import HttpUser, events, task, between
import httpx

from tests.config import settings


# Locust does NOT load pytest conftest.py, so the SUT readiness check
# implemented in tests/conftest.py::_verify_sut_ready does NOT run here.
# Every locustfile MUST replicate readiness via @events.test_start so
# Locust fails fast (rather than reporting 100% errors) when the SUT
# is unreachable or admin login is broken.
@events.test_start.add_listener
def _verify_sut_ready(environment, **_kwargs):
    base_url = settings.base_url
    try:
        resp = httpx.get(f"{base_url}/openapi.json", timeout=5)
    except Exception as exc:  # pragma: no cover - readiness fail-fast
        environment.runner.quit()
        raise SystemExit(
            f"SUT unreachable at {base_url} "
            f"({settings.base_url_source}): {exc}"
        )
    if resp.status_code != 200:
        environment.runner.quit()
        raise SystemExit(
            f"SUT not ready at {base_url}: GET /openapi.json -> "
            f"HTTP {resp.status_code}"
        )


class MenuListUser(HttpUser):
    host = settings.base_url
    wait_time = between(1, 2)

    # case_id TC_MENU_PERF_001
    @task
    def tc_menu_perf_001__menu_list(self):
        # auth per plan's strategy — never hardcode real tokens
        self.client.get("/api/v1/menu/list", name="menu-list-query")
```

- **Configuration source (mandatory):** every locustfile MUST `from tests.config import settings` and use `settings.base_url` (as the `HttpUser.host` and in the readiness listener), `settings.admin_username` / `settings.admin_password` (for auth setup), and any QA test-data prefixes from `settings`. Do **not** use `os.environ.get(...)`, `os.getenv(...)`, or hardcoded URLs/credentials.
- **Readiness check (mandatory):** every locustfile MUST register an `@events.test_start.add_listener` that probes `GET {settings.base_url}/openapi.json` and aborts the run via `environment.runner.quit()` + `raise SystemExit(...)` on failure. This mirrors `tests/conftest.py::_verify_sut_ready` for the Locust runner, which does not load pytest conftest. The listener message MUST include `settings.base_url_source` so on-call can tell whether the URL came from env or default.
- **The `@task` method name MUST be prefixed with the normalized case_id** (lowercase case_id + `__` + description): `def <case_id lowercase>__<description>(self)`. Locust tasks do **not** take a `test_` prefix. e.g. case_id `TC_MENU_PERF_001` → `def tc_menu_perf_001__menu_list(self)`. This is the mandatory source-level traceability marker. (Keep `name=` matching the scenario `capability` for threshold mapping — do **not** move the case_id into `name=` if it would break that mapping.)
- Endpoints, task weights, and the `name=` labels come from the plan and MUST match the scenario `capability` so the runner can map measured stats back to thresholds.
- The locustfile declares **load behavior only**; absolute thresholds (`p95_ms`, `error_rate_max`) live in the case/plan and are enforced by the CLI runner against Locust output — do **not** re-encode thresholds inside the locustfile.
- Output exactly to `tests/perf/locustfile_<module>.py`.
- `performance-codegen-plan.md` is a codegen guidance artifact, not the runner's execution target list. Phase 8 `aws-run` discovers executable Locust files via `tests/perf/locustfile*.py` and reads thresholds/load from selected `type: Performance` cases.

## Runner discovery contract (aws-run)

Phase 8 `aws-run` does **not** read `performance-codegen-plan.md` for execution targets. It discovers locustfiles via glob `tests/perf/locustfile*.py`, applies load/thresholds from selected Performance cases, and writes `performance-result.json`. Emit locustfiles under `tests/perf/` so this cross-skill contract holds.

## Test Failure Integrity

Generated performance tests MUST fail for the right reason. Rules:

- The locustfile must exercise the real endpoint(s) named in the plan — no stubbed/mocked responses.
- Do not add client-side retries or error-swallowing that hides 5xx / timeouts from Locust's stats (the runner reads `error_rate` from those stats).
- Do not relax the `name=` labels or endpoint paths after observing failures.
- Do not encode artificial sleeps that mask latency, or otherwise game `p95`.
- Auth setup may be flexible; the measured traffic must be representative of the scenario.

Self-check before reporting complete:
1. Does the load actually hit the endpoint(s) the thresholds are defined for?
2. Are failures (5xx/timeouts) reported to Locust's stats, not swallowed?
3. Do the `name=` labels match the scenario `capability` for threshold mapping?
4. Does every locustfile `from tests.config import settings` and use `settings.base_url` for `HttpUser.host` (no hardcoded URLs)?
5. Does every locustfile register `@events.test_start` readiness against `GET {settings.base_url}/openapi.json` that aborts via `environment.runner.quit()` + `raise SystemExit`?

If any answer is unsafe, fix the locustfile before reporting codegen complete.

## Hard Rules

- STOP if the gate (`performance-plan-review.json`) is not `pass` with empty blockers.
- Do not run Locust or produce execution results — that is Phase 8 `aws-run`.
- Do not encode pass/fail thresholds in the locustfile; thresholds are enforced by the CLI against absolute values from the case.
- Do not design new cases or change scope.
- Do not write to `tests/api/`, `tests/e2e/`, or `tests/fuzz/` — performance output goes to `tests/perf/` only.
- Do **not** read URLs / credentials / prefixes from `os.environ` or hardcoded literals in the locustfile — always go through `tests.config.settings`.
- Do **not** skip the `@events.test_start` readiness listener — Locust does not load pytest conftest, so this is the only readiness gate for the performance layer.
- If `tests/config.py` does not exist (test-infra not bootstrapped), STOP and request `aws-test-infra-bootstrap` to run — do not create it from `aws-performance-codegen`.
