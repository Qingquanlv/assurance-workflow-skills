# Src restructure eval parity evidence

Date: 2026-07-14

This record compares the last available pre-restructure fake runs with the compiled-executor
runs produced after the restructure. All comparisons use the same suite and smoke sample.
The run directories live under `eval/out/runs/`.

| Suite | Baseline run | Compiled run | Verdict | Metrics | Raw-output inventory |
|---|---|---|---|---|---|
| workflow-case | `eval-20260710-7269b62f-prlm` | `eval-20260714-871c58f1-ywtw` | pass → pass | exact | 9 → 9, exact |
| workflow-full | `eval-20260708-d6270b6f-uqjn` | `eval-20260714-871c58f1-2ak5` | pass → pass | see note 1 | 41 → 44, additive |
| workflow-api-codegen | `eval-20260710-7269b62f-2ay1` | `eval-20260714-871c58f1-losg` | pass → pass | exact | 13 → 13, exact |
| workflow-e2e-codegen | `eval-20260710-7269b62f-h5l1` | `eval-20260714-871c58f1-9wgz` | pass → pass | exact | 13 → 13, exact |
| workflow-fuzz-codegen | `eval-20260710-7269b62f-6l51` | `eval-20260714-871c58f1-0a1b` | pass → pass | exact | 12 → 12, exact |
| workflow-performance-codegen | `eval-20260710-7269b62f-5jp9` | `eval-20260714-871c58f1-0p1o` | pass → pass | exact | 12 → 12, exact |
| workflow-run | `eval-20260708-d6270b6f-vkqe` | `eval-20260714-871c58f1-sd9l` | pass → pass | exact | 16 → 19, additive |

For every pair, `stdout.log`, `stderr.log`, and `execution.json` are present on both sides.
No fake run emitted `TOOL_EVENT`, so `tool-events.jsonl` is absent on both sides. The five exact
inventory rows have no baseline-only or compiled-only paths.

1. The only `workflow-full` metric differences are the already-evolved healing/observability
   fields: `healing_triggered_rate` changed from 1 to 0, wall time is non-contractual, and the
   compiled run includes the process-observability counters. Both hard-gate verdicts remain pass.
   The three additive files are the canonical batch-layout execution evidence under
   `execution/runs/eval-fake-full/`.
2. The three additive `workflow-run` files are likewise canonical batch-layout evidence under
   `execution/runs/eval-fake-run/`; all contract metrics are exactly equal.

Policy and failure-path compatibility is covered by
`tests/eval/unit/executor_typed_dispatch.test.ts` and
`tests/eval/unit/eval_wrapper_functions.test.ts`: missing injected context, sandbox isolation,
custom allowed-write policy, env propagation, missing expected output, inner nonzero exit,
timeout evidence, and wrapper-owned evidence preservation.

Local smoke note: Python syntax scoring needed `PYTHONPYCACHEPREFIX=/tmp/aws-eval-pycache`
inside the managed macOS sandbox. After setting it, all seven compiled runs gated pass.
