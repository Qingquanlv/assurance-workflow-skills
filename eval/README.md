# Eval implementation and data index

> **Non-normative maintainer index.** Current user-facing commands,
> configuration, gate semantics, operating procedure, and exit behavior are
> defined only in [`docs/eval.md`](../docs/eval.md).

The `eval/` tree contains the data and contracts consumed by the AI Eval
harness. Runtime implementation lives in `src/eval/` and the CLI adapter lives
in `src/commands/eval.ts`.

| Path | Maintainer purpose |
|------|--------------------|
| `contracts/` | Metric registry, evidence format, and safety scope |
| `suites/` | Executor, dataset, thresholds, gates, and CI metadata per suite |
| `datasets/` | Versioned sample inputs and expected observations |
| `fixtures/` | Seed tiers, golden samples, and deterministic fakes |
| `plans/` | Checked-in batch plan inputs |
| `suts.yaml` | SUT registry and pinned revisions |
| `baselines/` | Human-approved metric baselines |
| `judge/` | Judge prompts and calibration data |
| `out/` | Ignored generated runs, batches, and reports |

Implementation entry points:

- `src/commands/eval.ts` — CLI command registration and exit handling
- `src/eval/runner.ts` — suite and plan orchestration
- `src/eval/gate.ts` — run gate evaluation
- `src/eval/report.ts` — run, trend, and baseline comparison reporting
- `src/eval/executor.ts` — typed executor dispatch

For contract-level maintainer detail, see `contracts/metric-spec.md`,
`contracts/evidence-spec.md`, and `contracts/safety-scope.md`. Do not add
user-facing command or behavior guidance here; update `docs/eval.md` instead.
