# Task 5 Report — Narrow Runtime Surface

## Status

Implemented the `WorkflowProgressionRuntime` three-method surface:
`inspect()`, `advance(outcome)`, and `resume()`.

## Delivered

- `inspect()` projects state and signs dispatch/heal actions without writing.
- `advance()` persists a missing `dispatch_signed`, verifies H0, applies the
  sealed phase outcome with dispatch-time freshness, then re-projects.
- `resume()` commits evidence-complete uncommitted dispatches and leaves
  incomplete attempts uncommitted so the next projection allocates a new ID.
- Retained standalone compatibility exports for state and gate commands.

## Verification

- PASS: `npm test -- --runInBand tests/unit/orchestration/progression.test.ts`
- EXPECTED BLOCKER: `npm run build` fails because Tasks 6–8 have not migrated
  `loop.ts`, review/healing drivers, and commands from removed runtime methods.
# Task 5 Report: Typed-Artifact JSON Validators

## Status

**Complete**

## Summary

Added four zod-backed JSON validators aligned with existing interfaces in `src/core/types.ts`. Each module exports a schema, a `validate*` function returning `{ ok, errors }`, and an `AssertAssignable` compile-time guard to prevent drift between zod-inferred types and core interfaces.

## Files Created

| File | Artifact |
|------|----------|
| `src/schema/execution_manifest.ts` | `ExecutionManifest` |
| `src/schema/failure_analysis.ts` | `FailureAnalysis` + `FailureEntry` |
| `src/schema/quality_gate_result.ts` | `QualityGateResult` + dimensions |
| `src/schema/quality_report.ts` | `QualityReport` |
| `tests/unit/schema/typed_artifacts.test.ts` | Unit tests (TDD) |

## Files Modified

- `src/schema/index.ts` — registered all four specs in `ARTIFACT_SPECS`

## Registry Entries

| artifact_type | glob |
|---------------|------|
| `execution_manifest` | `execution/execution-manifest.yaml` |
| `failure_analysis` | `inspect/failure-analysis.json` |
| `quality_gate_result` | `inspect/quality-gate-result.json` |
| `quality_report` | `report/quality-report.json` |

## TDD Flow

1. Wrote `tests/unit/schema/typed_artifacts.test.ts` — failed (modules not found)
2. Implemented four validator modules + registry entries
3. `npx jest tests/unit/schema/typed_artifacts.test.ts` — 4/4 pass
4. `npx tsc --noEmit` — pass (AssertAssignable guards hold)
5. Full schema suite — 14/14 pass

## Commit

```
feat(schema): add typed-artifact validators (manifest, failure-analysis, quality-gate, quality-report)
```

## Design Notes

- **`AssertAssignable`**: Each schema file exports `_XxxOk = AssertAssignable<Inferred, CoreInterface>` so `tsc` fails if zod output diverges from `core/types.ts`.
- **Loose optional fields**: `scope`, `human_decisions`, `minimum_required_coverage`, and `non_functional` use `z.any().optional()` where full sub-schema transcription was out of scope; assignability still holds.
- **Self-contained schemas**: `quality_report.ts` duplicates shared dimension shapes locally (does not import from `quality_gate_result.ts`) per brief.

## Concerns / Follow-ups

- **Stricter scope validation**: `CoverageScopeResult` is currently `z.any().optional()` in coverage dimensions; a future task could transcribe the full shape for runtime validation.
- **YAML vs JSON**: `execution_manifest` glob is `.yaml` but the validator accepts parsed object shape (same as registry `parseByExt` path); no YAML-specific constraints beyond structure.
- **Partial `result_files` keys**: Core type uses `Partial<Record<...>>`; zod uses `z.record(z.string(), z.string())` which is slightly wider at runtime but assignable to the interface.
