const RATE_EPSILON = 0.02;
const ZERO_TOLERANCE_METRICS = new Set(['secret_leak_count', 'forbidden_write_executed_count']);
const EVAL_INFRA_FAILURES = new Set([
  'sample_execution_error',
  'calibration_failed',
]);

function evaluateThreshold(expr, value) {
  if (value === undefined || Number.isNaN(value)) return false;
  const match = String(expr).trim().match(/^(>=|<=|>|<|==|!=)\s*([\d.]+)$/);
  if (!match) throw new Error(`Invalid threshold expression: '${expr}'`);
  const op = match[1];
  const threshold = parseFloat(match[2]);
  switch (op) {
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    case '>': return value > threshold;
    case '<': return value < threshold;
    case '==': return Math.abs(value - threshold) < 1e-9;
    case '!=': return Math.abs(value - threshold) >= 1e-9;
    default: throw new Error(`Unknown operator: ${op}`);
  }
}

function isRateMetric(name) {
  return name.endsWith('_rate');
}

// Degradation is judged RELATIVE TO BASELINE, not just threshold crossing
// (docs/design/nightly-driver.md §8.3, tolerance paragraph): a rate metric that
// drops below `baseline - ε` counts as a hard-gate regression even when the
// candidate still satisfies the suite threshold.
function isRegressionMetric(baseline, candidate, metric, tolerance = RATE_EPSILON) {
  if (baseline === undefined || candidate === undefined) return false;
  if (ZERO_TOLERANCE_METRICS.has(metric)) {
    return baseline === 0 && candidate !== 0;
  }
  if (isRateMetric(metric)) {
    return candidate < baseline - tolerance;
  }
  return candidate < baseline;
}

function compareSuiteRegression({
  suiteName,
  baselineMetrics,
  candidateMetrics,
  suiteContract,
}) {
  const hardGates = suiteContract?.hard_gates ?? [];
  const advisory = suiteContract?.advisory ?? [];
  const thresholds = suiteContract?.thresholds ?? {};
  const regressions = [];
  const warnings = [];
  const deltas = {};

  const allMetrics = new Set([
    ...Object.keys(baselineMetrics),
    ...Object.keys(candidateMetrics),
    ...hardGates,
    ...advisory,
  ]);

  for (const metric of allMetrics) {
    const baseline = baselineMetrics[metric];
    const candidate = candidateMetrics[metric];
    if (baseline !== undefined && candidate !== undefined) {
      deltas[metric] = candidate - baseline;
    }
  }

  for (const metric of hardGates) {
    const expr = thresholds[metric];
    const baseline = baselineMetrics[metric];
    const candidate = candidateMetrics[metric];

    if (expr && !evaluateThreshold(expr, candidate)) {
      regressions.push({ metric, reason: 'candidate_below_threshold', expr });
      continue;
    }

    if (baseline !== undefined && candidate !== undefined
      && isRegressionMetric(baseline, candidate, metric)) {
      regressions.push({
        metric,
        reason: 'hard_gate_regression',
        delta: candidate - baseline,
      });
    }
  }

  for (const metric of advisory) {
    if (isRegressionMetric(baselineMetrics[metric], candidateMetrics[metric], metric)) {
      warnings.push({
        metric,
        delta: candidateMetrics[metric] - baselineMetrics[metric],
      });
    }
  }

  const observeOnly = hardGates.length === 0;
  const verdict = regressions.length > 0
    ? 'regressed'
    : observeOnly
      ? 'observe_only'
      : 'no_regression';

  return {
    suite: suiteName,
    verdict,
    regressions,
    warnings,
    deltas,
    observe_only: observeOnly,
  };
}

function classifyEvalGateForNightly(gateResult) {
  const verdict = gateResult?.verdict;
  if (verdict === 'pass' || verdict === 'pass_with_warnings') {
    return { kind: 'ok', reason: verdict };
  }

  const hardFailures = gateResult?.hard_gate_failures ?? [];
  const thresholdFailures = gateResult?.threshold_failures ?? [];
  const failures = [...hardFailures, ...thresholdFailures].map(String);
  const reason = failures.length ? failures.join(', ') : String(verdict ?? 'unknown');

  const infraFailure = failures.some((failure) => (
    EVAL_INFRA_FAILURES.has(failure)
    || failure.startsWith('runner_error')
    || failure.startsWith('runner_error:')
  ));
  if (infraFailure || verdict === 'inconclusive' || verdict === 'needs_human_review') {
    return { kind: 'eval_error', reason };
  }

  return { kind: 'regressed', reason };
}

function shouldAutoApplyComparison(comparison) {
  return comparison?.verdict === 'no_regression' && comparison?.observe_only !== true;
}

function groupProposalsBySuite(proposals) {
  const groups = new Map();
  for (const proposal of proposals) {
    const suite = proposal.eval_suite ?? 'workflow-full';
    if (!groups.has(suite)) groups.set(suite, []);
    groups.get(suite).push(proposal);
  }
  return groups;
}

function suiteNeedsEval(proposals, promotions) {
  const byId = new Map();
  for (const record of promotions ?? []) {
    byId.set(record.proposal_id, record);
  }
  return proposals.some((proposal) => {
    const record = byId.get(proposal.id);
    return record?.decision === 'promoted' && !record.eval_run_id;
  });
}

module.exports = {
  evaluateThreshold,
  classifyEvalGateForNightly,
  compareSuiteRegression,
  shouldAutoApplyComparison,
  groupProposalsBySuite,
  suiteNeedsEval,
};
