import type { PromotionLike, ProposalLike } from './types';

const RATE_EPSILON = 0.02;
const ZERO_TOLERANCE_METRICS = new Set(['secret_leak_count', 'forbidden_write_executed_count']);
const EVAL_INFRA_FAILURES = new Set(['sample_execution_error', 'calibration_failed']);
type Metrics = Record<string, number>;

export function evaluateThreshold(expr: string, value: number | undefined): boolean {
  if (value === undefined || Number.isNaN(value)) return false;
  const match = String(expr).trim().match(/^(>=|<=|>|<|==|!=)\s*([\d.]+)$/);
  if (!match) throw new Error(`Invalid threshold expression: '${expr}'`);
  const threshold = parseFloat(match[2]);
  switch (match[1]) {
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    case '>': return value > threshold;
    case '<': return value < threshold;
    case '==': return Math.abs(value - threshold) < 1e-9;
    case '!=': return Math.abs(value - threshold) >= 1e-9;
    default: throw new Error(`Unknown operator: ${match[1]}`);
  }
}

function isRegressionMetric(
  baseline: number | undefined,
  candidate: number | undefined,
  metric: string,
  tolerance = RATE_EPSILON,
): boolean {
  if (baseline === undefined || candidate === undefined) return false;
  if (ZERO_TOLERANCE_METRICS.has(metric)) return baseline === 0 && candidate !== 0;
  return metric.endsWith('_rate') ? candidate < baseline - tolerance : candidate < baseline;
}

export interface SuiteComparison {
  suite: string;
  verdict: 'regressed' | 'observe_only' | 'no_regression';
  regressions: Array<Record<string, string | number>>;
  warnings: Array<{ metric: string; delta: number }>;
  deltas: Metrics;
  observe_only: boolean;
}

export function compareSuiteRegression(input: {
  suiteName: string;
  baselineMetrics: Metrics;
  candidateMetrics: Metrics;
  suiteContract: { hard_gates?: string[]; advisory?: string[]; thresholds?: Record<string, string>; observe?: string[] };
}): SuiteComparison {
  const { suiteName, baselineMetrics, candidateMetrics, suiteContract } = input;
  const hardGates = suiteContract?.hard_gates ?? [];
  const advisory = suiteContract?.advisory ?? [];
  const thresholds = suiteContract?.thresholds ?? {};
  const regressions: Array<Record<string, string | number>> = [];
  const warnings: Array<{ metric: string; delta: number }> = [];
  const deltas: Metrics = {};
  const allMetrics = new Set([...Object.keys(baselineMetrics), ...Object.keys(candidateMetrics), ...hardGates, ...advisory]);
  for (const metric of allMetrics) {
    const baseline = baselineMetrics[metric];
    const candidate = candidateMetrics[metric];
    if (baseline !== undefined && candidate !== undefined) deltas[metric] = candidate - baseline;
  }
  for (const metric of hardGates) {
    const expr = thresholds[metric];
    const baseline = baselineMetrics[metric];
    const candidate = candidateMetrics[metric];
    if (expr && !evaluateThreshold(expr, candidate)) {
      regressions.push({ metric, reason: 'candidate_below_threshold', expr });
      continue;
    }
    if (isRegressionMetric(baseline, candidate, metric)) {
      regressions.push({ metric, reason: 'hard_gate_regression', delta: candidate - baseline });
    }
  }
  for (const metric of advisory) {
    if (isRegressionMetric(baselineMetrics[metric], candidateMetrics[metric], metric)) {
      warnings.push({ metric, delta: candidateMetrics[metric] - baselineMetrics[metric] });
    }
  }
  const observeOnly = hardGates.length === 0;
  return {
    suite: suiteName,
    verdict: regressions.length > 0 ? 'regressed' : observeOnly ? 'observe_only' : 'no_regression',
    regressions,
    warnings,
    deltas,
    observe_only: observeOnly,
  };
}

export function classifyEvalGateForNightly(gateResult: any): {
  kind: 'ok' | 'eval_error' | 'regressed'; reason: string;
} {
  const verdict = gateResult?.verdict;
  if (verdict === 'pass' || verdict === 'pass_with_warnings') return { kind: 'ok', reason: verdict };
  const failures = [...(gateResult?.hard_gate_failures ?? []), ...(gateResult?.threshold_failures ?? [])].map(String);
  const reason = failures.length ? failures.join(', ') : String(verdict ?? 'unknown');
  const infraFailure = failures.some((failure) => EVAL_INFRA_FAILURES.has(failure)
    || failure.startsWith('runner_error'));
  if (infraFailure || verdict === 'inconclusive' || verdict === 'needs_human_review') {
    return { kind: 'eval_error', reason };
  }
  return { kind: 'regressed', reason };
}

export function shouldAutoApplyComparison(comparison: SuiteComparison): boolean {
  return comparison?.verdict === 'no_regression' && comparison?.observe_only !== true;
}

export function groupProposalsBySuite(proposals: ProposalLike[]): Map<string, ProposalLike[]> {
  const groups = new Map<string, ProposalLike[]>();
  for (const proposal of proposals) {
    const suite = proposal.eval_suite ?? 'workflow-full';
    const group = groups.get(suite) ?? [];
    group.push(proposal);
    groups.set(suite, group);
  }
  return groups;
}

export function suiteNeedsEval(proposals: ProposalLike[], promotions: PromotionLike[]): boolean {
  const byId = new Map(promotions.map((record) => [record.proposal_id, record]));
  return proposals.some((proposal) => {
    const record = byId.get(proposal.id);
    return record?.decision === 'promoted' && !record.eval_run_id;
  });
}
