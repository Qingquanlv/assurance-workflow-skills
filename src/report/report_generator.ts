/**
 * Quality Report generation (M1).
 *
 * Reads execution + inspect artifacts and produces a deterministic quality report:
 *   report/quality-report.json   (structured, CLI-written)
 *   report/quality-report.md     (full report)
 *   report/executive-summary.md  (one-page conclusion)
 *
 * The CLI is the only trusted layer for quality_score and final_status. The
 * skill layer may refine risk wording but must not recompute the score or
 * change final_status.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ApiResult,
  CoverageResult,
  E2eResult,
  FailureAnalysis,
  FailureEntry,
  GateStatus,
  QualityGateResult,
  QualityReport,
  ReportDefect,
  RiskLevel,
} from '../core/types';
import { computeQualityScore, ScoreDimension, ScoreDimensionKey } from './quality_score';

export interface GenerateReportOptions {
  changeId: string;
  projectRoot: string;
}

export interface GenerateReportResult {
  report: QualityReport;
  jsonPath: string;
  mdPath: string;
  execSummaryPath: string;
}

export function generateReport(opts: GenerateReportOptions): GenerateReportResult {
  const { changeId, projectRoot } = opts;
  const changeBase = path.join(projectRoot, 'qa', 'changes', changeId);
  const executionDir = path.join(changeBase, 'execution');
  const inspectDir = path.join(changeBase, 'inspect');
  const reportDir = path.join(changeBase, 'report');

  const apiResult = loadJson<ApiResult>(path.join(executionDir, 'api-result.json'));
  const e2eResult = loadJson<E2eResult>(path.join(executionDir, 'e2e-result.json'));
  const coverageResult = loadJson<CoverageResult>(path.join(executionDir, 'coverage-result.json'));
  const analysis = loadJson<FailureAnalysis>(path.join(inspectDir, 'failure-analysis.json'));
  const gate = loadJson<QualityGateResult>(path.join(inspectDir, 'quality-gate-result.json'));

  if (!gate) {
    throw new Error(
      `quality-gate-result.json not found for change "${changeId}". Run "aws report inspect --change ${changeId}" first.`,
    );
  }

  const batchId = gate.batch_id || apiResult?.batch_id || e2eResult?.batch_id || '';
  const finalStatus = gate.final_status;

  // ── Dimensions for scoring ────────────────────────────────────────────────
  // Functional score covers API + E2E only; fuzz is scored as its own dimension.
  const funcTotal = gate.dimensions.functional.api.total + gate.dimensions.functional.e2e.total;
  const funcPassed = gate.dimensions.functional.api.passed + gate.dimensions.functional.e2e.passed;
  const covAvailable = gate.dimensions.coverage.available;
  const covRatio = covAvailable && gate.dimensions.coverage.threshold.line > 0
    ? gate.dimensions.coverage.line_coverage / gate.dimensions.coverage.threshold.line
    : 0;

  // Fuzz dimension (M3): active only when fuzz actually ran (gate attaches counts).
  const fuzzCounts = gate.dimensions.functional.fuzz;
  const fuzzActive = !!fuzzCounts && fuzzCounts.total > 0;
  const fuzzRatio = fuzzActive ? fuzzCounts!.passed / fuzzCounts!.total : 0;

  // Performance dimension (M3): active when a non_functional dimension ran (not SKIPPED).
  const perf = gate.dimensions.non_functional;
  const perfScenarios = perf?.performance ?? [];
  const perfRan = perfScenarios.filter(s => s.verdict !== 'SKIPPED');
  const perfActive = !!perf && perf.status !== 'SKIPPED' && perfRan.length > 0;
  const perfRatio = perfActive ? perfRan.filter(s => s.verdict === 'PASS').length / perfRan.length : 0;

  // Weighting: M1 (functional 70, coverage 30) until a non-functional/fuzz layer
  // is in scope, then M3 weights (functional 50, coverage 20, fuzz 15, performance 15).
  const m3 = fuzzActive || perfActive;
  const weights = m3
    ? { functional: 50, coverage: 20, fuzz: 15, performance: 15 }
    : { functional: 70, coverage: 30, fuzz: 0, performance: 0 };

  const dims: Record<ScoreDimensionKey, ScoreDimension> = {
    functional: { active: funcTotal > 0, ratio: funcTotal > 0 ? funcPassed / funcTotal : 0, weight: weights.functional },
    coverage: { active: covAvailable, ratio: covRatio, weight: weights.coverage },
    fuzz: { active: fuzzActive, ratio: fuzzRatio, weight: weights.fuzz },
    performance: { active: perfActive, ratio: perfRatio, weight: weights.performance },
  };

  const { score, breakdown } = computeQualityScore(dims);

  // ── Defects bucketed from failure analysis ────────────────────────────────
  const defects = bucketDefects(analysis?.failures ?? []);

  // ── Deterministic risk level + recommendation (CLI baseline) ──────────────
  const { riskLevel, riskRationale } = computeRisk(finalStatus, defects, gate);
  const recommendation = computeRecommendation(finalStatus, defects);

  // ── Scope (best-effort) ───────────────────────────────────────────────────
  const scope = scanScope(changeBase);

  const report: QualityReport = {
    schema_version: '1.0',
    change_id: changeId,
    batch_id: batchId,
    final_status: finalStatus,
    quality_score: score,
    score_breakdown: breakdown,
    scope,
    functional: gate.dimensions.functional,
    coverage: gate.dimensions.coverage,
    non_functional: gate.dimensions.non_functional,
    defects,
    risk_level: riskLevel,
    risk_rationale: riskRationale,
    recommendation,
  };

  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'quality-report.json');
  const mdPath = path.join(reportDir, 'quality-report.md');
  const execSummaryPath = path.join(reportDir, 'executive-summary.md');

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  fs.writeFileSync(mdPath, buildReportMd(report), 'utf-8');
  fs.writeFileSync(execSummaryPath, buildExecutiveSummary(report), 'utf-8');

  return { report, jsonPath, mdPath, execSummaryPath };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

const PRODUCT_CATEGORIES = new Set([
  'business_logic_failure',
  'fuzz_stateful_failure',   // server fault surfaced by fuzzing → product robustness issue
  'perf_threshold_exceeded', // measured perf exceeded the agreed absolute threshold
]);
const ENVIRONMENT_CATEGORIES = new Set([
  'environment_failure',
  'perf_environment',        // target unreachable / no traffic recorded
]);

function bucketDefects(failures: FailureEntry[]): QualityReport['defects'] {
  const product: ReportDefect[] = [];
  const test: ReportDefect[] = [];
  const environment: ReportDefect[] = [];
  for (const f of failures) {
    const d: ReportDefect = { case_id: f.case_id, category: f.category, diagnosis: f.diagnosis };
    if (PRODUCT_CATEGORIES.has(f.category)) product.push(d);
    else if (ENVIRONMENT_CATEGORIES.has(f.category)) environment.push(d);
    else test.push(d);
  }
  return { product, test, environment };
}

function computeRisk(
  finalStatus: GateStatus,
  defects: QualityReport['defects'],
  gate: QualityGateResult,
): { riskLevel: RiskLevel; riskRationale: string } {
  if (defects.product.length > 0) {
    return {
      riskLevel: 'HIGH',
      riskRationale: `Detected ${defects.product.length} product-level defect(s); product behaviour is incorrect.`,
    };
  }
  if (finalStatus === 'FAIL') {
    return {
      riskLevel: 'HIGH',
      riskRationale: 'Functional gate failed — one or more selected test targets did not pass.',
    };
  }
  if (finalStatus === 'PASS_WITH_WARNINGS') {
    const covWarn = gate.dimensions.coverage.status === 'PASS_WITH_WARNINGS';
    const reasons: string[] = [];
    if (covWarn) reasons.push('coverage below threshold');
    if (defects.environment.length > 0) reasons.push(`${defects.environment.length} environment issue(s)`);
    if (defects.test.length > 0) reasons.push(`${defects.test.length} test-level issue(s)`);
    return {
      riskLevel: defects.test.length > 0 || defects.environment.length > 0 ? 'MEDIUM' : 'LOW',
      riskRationale: `All functional tests passed; warnings: ${reasons.join(', ') || 'none'}.`,
    };
  }
  if (finalStatus === 'SKIPPED') {
    return { riskLevel: 'MEDIUM', riskRationale: 'No test targets ran — quality cannot be assessed.' };
  }
  return { riskLevel: 'LOW', riskRationale: 'All dimensions passed with no defects.' };
}

function computeRecommendation(finalStatus: GateStatus, defects: QualityReport['defects']): string {
  if (finalStatus === 'FAIL') {
    return 'Do not release: failing tests or hard blockers must be resolved first.';
  }
  if (defects.product.length > 0) {
    return 'Release only with caution — unresolved product defects exist; track them as known issues.';
  }
  if (finalStatus === 'PASS_WITH_WARNINGS') {
    return 'Release is acceptable but address the noted warnings (e.g. coverage).';
  }
  if (finalStatus === 'SKIPPED') {
    return 'No tests ran — run the suite before deciding on release.';
  }
  return 'Safe to release.';
}

interface Scope {
  cases: number;
  requirements: string[];
}

/** Best-effort scope scan: counts case.yaml files under the change and gathers requirement_id values. */
function scanScope(changeBase: string): Scope {
  const casesDir = path.join(changeBase, 'cases');
  const files: string[] = [];
  collectCaseFiles(casesDir, files);
  const requirements = new Set<string>();
  const reqRe = /requirement_id\s*:\s*["']?([A-Za-z0-9_-]+)/g;
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      let m: RegExpExecArray | null;
      while ((m = reqRe.exec(content)) !== null) requirements.add(m[1]);
    } catch {
      /* ignore unreadable file */
    }
  }
  return { cases: files.length, requirements: [...requirements].sort() };
}

function collectCaseFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectCaseFiles(full, out);
    else if (/case.*\.ya?ml$/i.test(entry.name)) out.push(full);
  }
}

// ─── Markdown writers ───────────────────────────────────────────────────────

function fmtBreakdown(v: number | 'N/A'): string {
  return v === 'N/A' ? 'N/A' : `${v}`;
}

function buildReportMd(r: QualityReport): string {
  const c = r.coverage;
  const lines: string[] = [
    `# Quality Report — ${r.change_id}`,
    '',
    `- **Batch**: ${r.batch_id || '(unknown)'}`,
    `- **Final Status**: ${r.final_status}`,
    `- **Quality Score**: ${r.quality_score} / 100`,
    `- **Risk Level**: ${r.risk_level}`,
    '',
    '## Score Breakdown',
    '',
    '| Dimension | Points |',
    '|-----------|--------|',
    `| Functional | ${fmtBreakdown(r.score_breakdown.functional)} |`,
    `| Coverage | ${fmtBreakdown(r.score_breakdown.coverage)} |`,
    `| Fuzz | ${fmtBreakdown(r.score_breakdown.fuzz)} |`,
    `| Performance | ${fmtBreakdown(r.score_breakdown.performance)} |`,
    '',
    '## Scope',
    '',
    `- Cases: ${r.scope.cases}`,
    `- Requirements: ${r.scope.requirements.length > 0 ? r.scope.requirements.join(', ') : '(none detected)'}`,
    '',
    '## Functional',
    '',
    `- API: total=${r.functional.api.total} passed=${r.functional.api.passed} failed=${r.functional.api.failed}`,
    `- E2E: total=${r.functional.e2e.total} passed=${r.functional.e2e.passed} failed=${r.functional.e2e.failed}`,
    ...(r.functional.fuzz
      ? [`- Fuzz: total=${r.functional.fuzz.total} passed=${r.functional.fuzz.passed} failed=${r.functional.fuzz.failed}`]
      : []),
    '',
    '## Coverage',
    '',
    c.available
      ? `- Line: ${c.line_coverage}% (threshold ${c.threshold.line}%)\n- Branch: ${c.branch_coverage}% (threshold ${c.threshold.branch}%)\n- Status: ${c.status}`
      : '- Not collected (pytest-cov unavailable or disabled). Treated as a warning, not a failure.',
    '',
    ...nonFunctionalSection(r),
    '## Defects',
    '',
    `- Product: ${r.defects.product.length}`,
    `- Test: ${r.defects.test.length}`,
    `- Environment: ${r.defects.environment.length}`,
    '',
    ...defectSection('Product Defects', r.defects.product),
    ...defectSection('Test Defects', r.defects.test),
    ...defectSection('Environment Defects', r.defects.environment),
    '## Risk & Recommendation',
    '',
    `- **Risk Level**: ${r.risk_level}`,
    `- **Rationale**: ${r.risk_rationale}`,
    `- **Recommendation**: ${r.recommendation}`,
    '',
  ];
  return lines.join('\n');
}

function nonFunctionalSection(r: QualityReport): string[] {
  const nf = r.non_functional;
  if (!nf) return [];
  const out: string[] = ['## Non-Functional (Performance)', '', `- Status: ${nf.status}`];
  if (nf.performance.length === 0) {
    out.push('- No performance scenarios recorded.');
  } else {
    out.push('', '| Capability | Endpoint | p95 (ms) | p95 threshold | Error rate | Error max | Verdict |');
    out.push('|------------|----------|----------|---------------|------------|-----------|---------|');
    for (const s of nf.performance) {
      out.push(
        `| ${s.capability} | ${s.endpoint} | ${s.measured_p95_ms ?? 'N/A'} | ${s.threshold_p95_ms} `
          + `| ${s.measured_error_rate ?? 'N/A'} | ${s.threshold_error_rate_max} | ${s.verdict} |`,
      );
    }
  }
  out.push('');
  return out;
}

function defectSection(title: string, defects: ReportDefect[]): string[] {
  if (defects.length === 0) return [];
  const out = [`### ${title}`, ''];
  for (const d of defects) {
    out.push(`- \`${d.case_id}\` (${d.category}): ${d.diagnosis}`);
  }
  out.push('');
  return out;
}

function buildExecutiveSummary(r: QualityReport): string {
  return [
    `# Executive Summary — ${r.change_id}`,
    '',
    `**Final Status**: ${r.final_status}  |  **Quality Score**: ${r.quality_score}/100  |  **Risk**: ${r.risk_level}`,
    '',
    `${r.risk_rationale}`,
    '',
    `**Recommendation**: ${r.recommendation}`,
    '',
    `Functional: ${r.functional.api.passed + r.functional.e2e.passed}/${r.functional.api.total + r.functional.e2e.total} passed.`
      + (r.functional.fuzz ? ` Fuzz: ${r.functional.fuzz.passed}/${r.functional.fuzz.total} passed.` : '')
      + (r.coverage.available ? ` Coverage: ${r.coverage.line_coverage}% line.` : ' Coverage: not collected.')
      + (r.non_functional ? ` Performance: ${r.non_functional.status}.` : ''),
    '',
  ].join('\n');
}
