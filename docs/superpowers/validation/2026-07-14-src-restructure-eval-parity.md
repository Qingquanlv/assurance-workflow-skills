# Src restructure eval parity evidence

Date: 2026-07-14

This record compares freshly reconstructed runs at the exact pre-restructure fixed point
`ea56893af73b67c0c785883ef5dc9c80c71f0fbb` with compiled-executor runs produced after the
restructure. The fixed point was checked out into an isolated `/tmp` clone, built with the same
dependencies, and run against an identically created temporary SUT. All comparisons use the same
suite, smoke sample, fake mode, and `PYTHONPYCACHEPREFIX`.

| Suite | Baseline run | Compiled run | Verdict | Metrics | Raw-output inventory |
|---|---|---|---|---|---|
| workflow-case | `eval-20260714-ea56893a-o65o` | `eval-20260714-871c58f1-ywtw` | pass → pass | exact | 9 → 9, exact |
| workflow-full | `eval-20260714-ea56893a-hwtg` | `eval-20260714-871c58f1-2ak5` | pass → pass | exact except wall time | 44 → 44, exact |
| workflow-api-codegen | `eval-20260714-ea56893a-aqsk` | `eval-20260714-871c58f1-losg` | pass → pass | exact | 13 → 13, exact |
| workflow-e2e-codegen | `eval-20260714-ea56893a-7cs8` | `eval-20260714-871c58f1-9wgz` | pass → pass | exact | 13 → 13, exact |
| workflow-fuzz-codegen | `eval-20260714-ea56893a-npik` | `eval-20260714-871c58f1-0a1b` | pass → pass | exact | 12 → 12, exact |
| workflow-performance-codegen | `eval-20260714-ea56893a-50uw` | `eval-20260714-871c58f1-0p1o` | pass → pass | exact | 12 → 12, exact |
| workflow-run | `eval-20260714-ea56893a-bdkw` | `eval-20260714-871c58f1-sd9l` | pass → pass | exact | 19 → 19, exact |

For every pair, `stdout.log`, `stderr.log`, and `execution.json` are present on both sides.
No fake run emitted `TOOL_EVENT`, so `tool-events.jsonl` is absent on both sides. All seven
raw-output inventories have no baseline-only or compiled-only paths.

The sole metric-value difference is `workflow-full.wall_time_seconds` (`0.309` versus `0.167`),
which is measured wall-clock duration rather than a deterministic quality metric. Every quality,
evidence, healing, and observability metric is exactly equal.

Policy and failure-path compatibility is covered by
`tests/eval/unit/executor_typed_dispatch.test.ts` and
`tests/eval/unit/eval_wrapper_functions.test.ts`: missing injected context, sandbox isolation,
custom allowed-write policy, env propagation, missing expected output, inner nonzero exit,
timeout evidence, and wrapper-owned evidence preservation.

Local smoke note: Python syntax scoring needed `PYTHONPYCACHEPREFIX=/tmp/aws-eval-pycache`
inside the managed macOS sandbox. After setting it, all seven compiled runs gated pass.
