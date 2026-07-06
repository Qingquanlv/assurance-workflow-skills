/**
 * Builds the unified quality-gate-result.json (M1) from execution + coverage results.
 *
 * The gate is deterministic and worst-wins across dimensions. M1 covers two
 * dimensions (functional, coverage); M3 Phase D adds functional.fuzz and the
 * non_functional (performance) dimension via {@link extendQualityGate}.
 */
import {
  ApiResult,
  CoverageResult,
  E2eResult,
  FuzzResult,
  FunctionalCounts,
  GateStatus,
  NonFunctionalDimension,
  PerformanceResult,
  QualityGateResult,
} from '../core/types';

export interface BuildQualityGateOptions {
  changeId: string;
  batchId: string;
  apiResult: ApiResult | null;
  e2eResult: E2eResult | null;
  coverageResult: CoverageResult | null;
  /** From .aws/config.yaml coverage.gate_mode — 'block' turns below-threshold into FAIL. */
  coverageGateMode: 'warn' | 'block';
  /** M3 Phase D: fuzz folds into the functional dimension. */
  fuzzResult?: FuzzResult | null;
  /** M3 Phase D: performance forms the non_functional dimension. */
  performanceResult?: PerformanceResult | null;
}

/** worst-wins: FAIL > PASS_WITH_WARNINGS > PASS > SKIPPED. */
export function worstStatus(statuses: GateStatus[]): GateStatus {
  const present = statuses.filter(Boolean);
  if (present.length === 0) return 'SKIPPED';
  if (present.includes('FAIL')) return 'FAIL';
  if (present.includes('PASS_WITH_WARNINGS')) return 'PASS_WITH_WARNINGS';
  if (present.includes('PASS')) return 'PASS';
  return 'SKIPPED';
}

function counts(result: ApiResult | E2eResult | FuzzResult | null): FunctionalCounts {
  if (!result) return { total: 0, passed: 0, failed: 0 };
  return { total: result.total, passed: result.passed, failed: result.failed };
}

/** Functional status from raw counts: any failed → FAIL; ran & none failed → PASS; nothing ran → SKIPPED. */
function functionalStatus(...results: (ApiResult | E2eResult | FuzzResult | null | undefined)[]): GateStatus {
  const ran = results.filter(r => r && r.total > 0);
  if (ran.length === 0) return 'SKIPPED';
  if (ran.some(r => r!.failed > 0)) return 'FAIL';
  return 'PASS';
}

/** Non-functional (performance) dimension from the Locust result. */
function nonFunctionalDimension(perf: PerformanceResult | null | undefined): NonFunctionalDimension | undefined {
  if (!perf) return undefined;
  let status: GateStatus;
  if (!perf.available) status = 'SKIPPED';
  else if (perf.status === 'FAIL') status = 'FAIL';
  else if (perf.status === 'PASS') status = 'PASS';
  else status = 'SKIPPED';
  return { status, performance: perf.scenarios };
}

function coverageDimensionStatus(
  coverageResult: CoverageResult | null,
  gateMode: 'warn' | 'block',
): GateStatus {
  if (!coverageResult || !coverageResult.available) return 'SKIPPED';
  if (coverageResult.status === 'PASS') return 'PASS';
  // PASS_WITH_WARNINGS (below threshold): block mode escalates to FAIL.
  return gateMode === 'block' ? 'FAIL' : 'PASS_WITH_WARNINGS';
}

export function buildQualityGate(opts: BuildQualityGateOptions): QualityGateResult {
  const { changeId, batchId, apiResult, e2eResult, coverageResult, coverageGateMode, fuzzResult, performanceResult } = opts;

  // Fuzz folds into the functional dimension (input-robustness is still functional correctness).
  const funcStatus = functionalStatus(apiResult, e2eResult, fuzzResult);
  const covStatus = coverageDimensionStatus(coverageResult, coverageGateMode);
  const nonFunctional = nonFunctionalDimension(performanceResult);

  const dimensions: QualityGateResult['dimensions'] = {
    functional: {
      status: funcStatus,
      api: counts(apiResult),
      e2e: counts(e2eResult),
    },
    coverage: {
      status: covStatus,
      available: !!coverageResult?.available,
      line_coverage: coverageResult?.line_coverage ?? 0,
      branch_coverage: coverageResult?.branch_coverage ?? 0,
      threshold: coverageResult?.threshold ?? { line: 0, branch: 0 },
      ...(coverageResult?.scope ? { scope: coverageResult.scope } : {}),
    },
  };

  // Only attach fuzz counts when fuzz actually ran, to keep M1-shaped gates clean.
  if (fuzzResult && fuzzResult.status !== 'skipped') {
    dimensions.functional.fuzz = counts(fuzzResult);
  }

  const gateStatuses: GateStatus[] = [funcStatus, covStatus];
  if (nonFunctional) {
    dimensions.non_functional = nonFunctional;
    gateStatuses.push(nonFunctional.status);
  }

  return {
    schema_version: '1.0',
    change_id: changeId,
    batch_id: batchId,
    dimensions,
    final_status: worstStatus(gateStatuses),
  };
}
